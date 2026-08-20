#include "WindowsAudioCommon.hpp"

#include <devpkey.h>
#include <bcrypt.h>
#include <wincrypt.h>
#include <mscat.h>
#include <newdev.h>
#include <setupapi.h>
#include <softpub.h>
#include <wintrust.h>

#include <chrono>
#include <filesystem>
#include <optional>
#include <set>
#include <sstream>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

namespace {

using cpv::windows::ComPtr;

constexpr wchar_t kHardwareId[] = L"ROOT\\CPVAudioSink";
constexpr wchar_t kInfName[] = L"PersonaVoiceSink.inf";
constexpr wchar_t kCatalogName[] = L"cpv-audio-sink.cat";
constexpr wchar_t kDriverName[] = L"cpv-audio-sink.sys";
constexpr wchar_t kDriverDirectory[] = L"driver";
constexpr DWORD kMaximumClassNameCharacters = 32;
bool suppressProtocolOutput = false;

class DeviceInfoSet {
 public:
  explicit DeviceInfoSet(HDEVINFO value = INVALID_HANDLE_VALUE) : value_(value) {}
  ~DeviceInfoSet() {
    if (value_ != INVALID_HANDLE_VALUE) SetupDiDestroyDeviceInfoList(value_);
  }
  DeviceInfoSet(const DeviceInfoSet&) = delete;
  DeviceInfoSet& operator=(const DeviceInfoSet&) = delete;
  DeviceInfoSet(DeviceInfoSet&& other) noexcept : value_(other.release()) {}
  DeviceInfoSet& operator=(DeviceInfoSet&& other) noexcept {
    if (this != &other) reset(other.release());
    return *this;
  }
  HDEVINFO get() const { return value_; }
  explicit operator bool() const { return value_ != INVALID_HANDLE_VALUE; }

  HDEVINFO release() {
    const HDEVINFO value = value_;
    value_ = INVALID_HANDLE_VALUE;
    return value;
  }

  void reset(HDEVINFO value = INVALID_HANDLE_VALUE) {
    if (value_ != INVALID_HANDLE_VALUE) SetupDiDestroyDeviceInfoList(value_);
    value_ = value;
  }

 private:
  HDEVINFO value_{INVALID_HANDLE_VALUE};
};

std::string win32Message(DWORD error) {
  return cpv::windows::hresultMessage(HRESULT_FROM_WIN32(error));
}

bool emitReady(std::string_view action, bool installed, bool rebootRequired,
               bool catalogVerifiedForAction,
               std::optional<bool> installationChanged = std::nullopt) {
  if (suppressProtocolOutput) return true;
  std::ostringstream json;
  json << "{\"type\":\"ready\",\"helper\":\"driver-manager\",\"protocolVersion\":1"
       << ",\"backend\":\"windows-setupapi\",\"action\":\""
       << cpv::windows::jsonEscape(action) << "\",\"installed\":"
       << (installed ? "true" : "false")
       << ",\"rebootRequired\":" << (rebootRequired ? "true" : "false")
       << ",\"catalogVerifiedForAction\":"
       << (catalogVerifiedForAction ? "true" : "false")
       << ",\"fixedResourcePackage\":true"
       << ",\"requiresElevation\":true"
       << ",\"elevationManifestVerified\":true"
       << ",\"hardwareId\":\"ROOT\\\\CPVAudioSink\"";
  if (installationChanged.has_value()) {
    json << ",\"installationChanged\":"
         << (*installationChanged ? "true" : "false");
  }
  json << "}";
  return cpv::windows::writeJSON(cpv::FrameType::Ready, json.str());
}

int fail(std::string_view code, std::string_view message) {
  if (!suppressProtocolOutput) cpv::windows::writeError(code, message);
  return 1;
}

bool elevated() {
  HANDLE rawToken = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &rawToken)) return false;
  cpv::windows::ScopedHandle token(rawToken);
  TOKEN_ELEVATION elevation{};
  DWORD size = 0;
  return GetTokenInformation(
             token.get(), TokenElevation, &elevation, sizeof(elevation), &size) &&
      elevation.TokenIsElevated != 0;
}

bool embeddedElevationManifest() {
  HRSRC resource = FindResourceW(
      nullptr, MAKEINTRESOURCEW(1), RT_MANIFEST);
  if (resource == nullptr) return false;
  const DWORD size = SizeofResource(nullptr, resource);
  HGLOBAL loaded = LoadResource(nullptr, resource);
  const void* bytes = loaded == nullptr ? nullptr : LockResource(loaded);
  if (bytes == nullptr || size == 0) return false;
  const std::string_view manifest(static_cast<const char*>(bytes), size);
  return manifest.find("requireAdministrator") != std::string_view::npos;
}

bool regularFile(const std::filesystem::path& path) {
  std::error_code error;
  return std::filesystem::is_regular_file(path, error) && !error;
}

struct DriverPackage {
  std::filesystem::path directory;
  std::filesystem::path inf;
  std::filesystem::path catalog;
  std::filesystem::path driver;
};

bool executableDirectory(std::filesystem::path* output, std::string* error) {
  if (output == nullptr || error == nullptr) return false;
  std::vector<wchar_t> value(32'768);
  const DWORD length = GetModuleFileNameW(
      nullptr, value.data(), static_cast<DWORD>(value.size()));
  if (length == 0 || length >= value.size()) {
    *error = "Windows could not resolve the installed driver manager location";
    return false;
  }
  *output = std::filesystem::path(std::wstring_view(value.data(), length)).parent_path();
  return !output->empty();
}

bool resolvePackage(DriverPackage* output, std::string* error) {
  if (output == nullptr || error == nullptr) return false;
  std::filesystem::path executableRoot;
  if (!executableDirectory(&executableRoot, error)) return false;
  std::error_code filesystemError;
  const std::filesystem::path directory = std::filesystem::weakly_canonical(
      executableRoot / kDriverDirectory, filesystemError);
  if (filesystemError || !std::filesystem::is_directory(directory, filesystemError) ||
      filesystemError) {
    *error = "The driver package directory does not exist or cannot be resolved";
    return false;
  }
  DriverPackage package{
      directory,
      directory / kInfName,
      directory / kCatalogName,
      directory / kDriverName,
  };
  if (!regularFile(package.inf) || !regularFile(package.catalog) ||
      !regularFile(package.driver)) {
    *error = "The signed driver package must contain PersonaVoiceSink.inf, "
             "cpv-audio-sink.cat, and cpv-audio-sink.sys";
    return false;
  }
  *output = std::move(package);
  return true;
}

HRESULT verifyCatalog(const std::filesystem::path& catalog);

class CatalogHandle {
 public:
  explicit CatalogHandle(HANDLE value = INVALID_HANDLE_VALUE) : value_(value) {}
  ~CatalogHandle() {
    if (value_ != INVALID_HANDLE_VALUE) CryptCATClose(value_);
  }
  CatalogHandle(const CatalogHandle&) = delete;
  CatalogHandle& operator=(const CatalogHandle&) = delete;
  HANDLE get() const { return value_; }
  explicit operator bool() const { return value_ != INVALID_HANDLE_VALUE; }

 private:
  HANDLE value_{INVALID_HANDLE_VALUE};
};

class CatalogAdminHandle {
 public:
  explicit CatalogAdminHandle(HCATADMIN value = nullptr) : value_(value) {}
  ~CatalogAdminHandle() {
    if (value_ != nullptr) CryptCATAdminReleaseContext(value_, 0);
  }
  CatalogAdminHandle(const CatalogAdminHandle&) = delete;
  CatalogAdminHandle& operator=(const CatalogAdminHandle&) = delete;
  HCATADMIN get() const { return value_; }
  explicit operator bool() const { return value_ != nullptr; }

 private:
  HCATADMIN value_{nullptr};
};

bool catalogContainsFile(const std::filesystem::path& catalogPath,
                         const std::filesystem::path& memberPath) {
  HCATADMIN rawAdmin = nullptr;
  if (!CryptCATAdminAcquireContext2(
          &rawAdmin, nullptr, BCRYPT_SHA256_ALGORITHM, nullptr, 0)) {
    return false;
  }
  CatalogAdminHandle admin(rawAdmin);
  cpv::windows::ScopedHandle member(CreateFileW(
      memberPath.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL, nullptr));
  if (!member) return false;
  DWORD hashBytes = 0;
  if (!CryptCATAdminCalcHashFromFileHandle2(
          admin.get(), member.get(), &hashBytes, nullptr, 0) || hashBytes == 0) {
    return false;
  }
  std::vector<BYTE> hash(hashBytes);
  if (!CryptCATAdminCalcHashFromFileHandle2(
          admin.get(), member.get(), &hashBytes, hash.data(), 0)) {
    return false;
  }
  std::wstring tag;
  tag.reserve(static_cast<std::size_t>(hashBytes) * 2);
  constexpr wchar_t digits[] = L"0123456789ABCDEF";
  for (DWORD index = 0; index < hashBytes; ++index) {
    tag.push_back(digits[(hash[index] >> 4) & 0x0f]);
    tag.push_back(digits[hash[index] & 0x0f]);
  }
  CatalogHandle catalog(CryptCATOpen(
      const_cast<LPWSTR>(catalogPath.c_str()), CRYPTCAT_OPEN_EXISTING,
      0, CRYPTCAT_VERSION_1, 0));
  return catalog && CryptCATGetMemberInfo(catalog.get(), tag.data()) != nullptr;
}

HRESULT verifyCatalog(const std::filesystem::path& catalog) {
  WINTRUST_FILE_INFO file{};
  file.cbStruct = sizeof(file);
  file.pcwszFilePath = catalog.c_str();
  WINTRUST_DATA trust{};
  trust.cbStruct = sizeof(trust);
  trust.dwUIChoice = WTD_UI_NONE;
  trust.fdwRevocationChecks = WTD_REVOKE_WHOLECHAIN;
  trust.dwUnionChoice = WTD_CHOICE_FILE;
  trust.pFile = &file;
  trust.dwStateAction = WTD_STATEACTION_VERIFY;
  trust.dwProvFlags = WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT;
  GUID policy = WINTRUST_ACTION_GENERIC_VERIFY_V2;
  const LONG status = WinVerifyTrust(nullptr, &policy, &trust);
  trust.dwStateAction = WTD_STATEACTION_CLOSE;
  WinVerifyTrust(nullptr, &policy, &trust);
  return static_cast<HRESULT>(status);
}

std::vector<wchar_t> deviceProperty(HDEVINFO devices, SP_DEVINFO_DATA* device,
                                    DWORD property) {
  DWORD required = 0;
  DWORD type = 0;
  SetupDiGetDeviceRegistryPropertyW(
      devices, device, property, &type, nullptr, 0, &required);
  if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || required == 0) return {};
  std::vector<wchar_t> value((required + sizeof(wchar_t) - 1) / sizeof(wchar_t));
  if (!SetupDiGetDeviceRegistryPropertyW(
          devices, device, property, &type,
          reinterpret_cast<PBYTE>(value.data()),
          static_cast<DWORD>(value.size() * sizeof(wchar_t)), nullptr)) {
    return {};
  }
  return value;
}

bool multiStringContains(const std::vector<wchar_t>& values,
                         std::wstring_view expected) {
  std::size_t offset = 0;
  while (offset < values.size() && values[offset] != L'\0') {
    std::size_t end = offset;
    while (end < values.size() && values[end] != L'\0') ++end;
    if (end == values.size()) return false;
    const std::wstring_view value(values.data() + offset, end - offset);
    if (value.size() == expected.size() &&
        CompareStringOrdinal(
            value.data(), static_cast<int>(value.size()),
            expected.data(), static_cast<int>(expected.size()), TRUE) == CSTR_EQUAL) {
      return true;
    }
    offset = end + 1;
  }
  return false;
}

struct OwnedDevice {
  SP_DEVINFO_DATA data{};
  std::wstring driverInfName;
};

std::wstring driverInfName(HDEVINFO devices, SP_DEVINFO_DATA* device) {
  DEVPROPTYPE type = 0;
  DWORD required = 0;
  SetupDiGetDevicePropertyW(
      devices, device, &DEVPKEY_Device_DriverInfPath, &type, nullptr, 0,
      &required, 0);
  if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || required < sizeof(wchar_t)) return {};
  std::vector<BYTE> buffer(required);
  if (!SetupDiGetDevicePropertyW(
          devices, device, &DEVPKEY_Device_DriverInfPath, &type,
          buffer.data(), static_cast<DWORD>(buffer.size()), nullptr, 0) ||
      type != DEVPROP_TYPE_STRING) {
    return {};
  }
  return reinterpret_cast<const wchar_t*>(buffer.data());
}

std::vector<OwnedDevice> ownedDevices(HDEVINFO devices, bool* complete) {
  *complete = false;
  std::vector<OwnedDevice> result;
  for (DWORD index = 0;; ++index) {
    SP_DEVINFO_DATA device{};
    device.cbSize = sizeof(device);
    if (!SetupDiEnumDeviceInfo(devices, index, &device)) {
      if (GetLastError() == ERROR_NO_MORE_ITEMS) {
        *complete = true;
        return result;
      }
      return {};
    }
    const std::vector<wchar_t> hardwareIds = deviceProperty(devices, &device, SPDRP_HARDWAREID);
    if (!hardwareIds.empty() && multiStringContains(hardwareIds, kHardwareId)) {
      result.push_back(OwnedDevice{device, driverInfName(devices, &device)});
    }
  }
}

bool removeDevice(HDEVINFO devices, SP_DEVINFO_DATA* device, bool* rebootRequired) {
  SP_REMOVEDEVICE_PARAMS remove{};
  remove.ClassInstallHeader.cbSize = sizeof(SP_CLASSINSTALL_HEADER);
  remove.ClassInstallHeader.InstallFunction = DIF_REMOVE;
  remove.Scope = DI_REMOVEDEVICE_GLOBAL;
  remove.HwProfile = 0;
  if (!SetupDiSetClassInstallParamsW(
          devices, device, &remove.ClassInstallHeader, sizeof(remove)) ||
      !SetupDiCallClassInstaller(DIF_REMOVE, devices, device)) {
    return false;
  }
  SP_DEVINSTALL_PARAMS_W parameters{};
  parameters.cbSize = sizeof(parameters);
  if (SetupDiGetDeviceInstallParamsW(devices, device, &parameters) &&
      (parameters.Flags & (DI_NEEDREBOOT | DI_NEEDRESTART)) != 0) {
    *rebootRequired = true;
  }
  return true;
}

bool createRootDevice(const std::filesystem::path& inf, DeviceInfoSet* outputSet,
                      SP_DEVINFO_DATA* outputDevice) {
  GUID classGuid{};
  wchar_t className[kMaximumClassNameCharacters]{};
  if (!SetupDiGetINFClassW(
          inf.c_str(), &classGuid, className, kMaximumClassNameCharacters, nullptr)) {
    return false;
  }
  DeviceInfoSet devices(SetupDiCreateDeviceInfoList(&classGuid, nullptr));
  if (!devices) return false;
  SP_DEVINFO_DATA device{};
  device.cbSize = sizeof(device);
  if (!SetupDiCreateDeviceInfoW(
          devices.get(), className, &classGuid, nullptr, nullptr,
          DICD_GENERATE_ID, &device)) {
    return false;
  }
  const std::wstring hardwareMultiString = std::wstring(kHardwareId) + L'\0' + L'\0';
  if (!SetupDiSetDeviceRegistryPropertyW(
          devices.get(), &device, SPDRP_HARDWAREID,
          reinterpret_cast<const BYTE*>(hardwareMultiString.data()),
          static_cast<DWORD>(hardwareMultiString.size() * sizeof(wchar_t))) ||
      !SetupDiCallClassInstaller(DIF_REGISTERDEVICE, devices.get(), &device)) {
    return false;
  }
  *outputDevice = device;
  *outputSet = std::move(devices);
  return true;
}

struct StagedInf {
  bool copied{false};
  std::wstring oemInfName;
};

bool stageInf(const DriverPackage& package, StagedInf* staged) {
  wchar_t destination[MAX_PATH]{};
  DWORD required = 0;
  wchar_t* component = nullptr;
  const BOOL copied = SetupCopyOEMInfW(
      package.inf.c_str(), package.directory.c_str(), SPOST_PATH,
      SP_COPY_NOOVERWRITE, destination, MAX_PATH, &required, &component);
  if (!copied && GetLastError() != ERROR_FILE_EXISTS) return false;
  if (destination[0] == L'\0') {
    SetLastError(ERROR_INVALID_DATA);
    return false;
  }
  staged->copied = copied != FALSE;
  staged->oemInfName = std::filesystem::path(destination).filename().wstring();
  return true;
}

bool rollbackStagedInf(const StagedInf& staged) {
  return !staged.copied || SetupUninstallOEMInfW(
      staged.oemInfName.c_str(), SUOI_FORCEDELETE, nullptr);
}

bool installedSinkCount(std::size_t* output) {
  if (output == nullptr) return false;
  *output = 0;
  ComPtr<IMMDeviceEnumerator> enumerator;
  if (FAILED(CoCreateInstance(
          __uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
          IID_PPV_ARGS(enumerator.GetAddressOf())))) return false;
  ComPtr<IMMDeviceCollection> devices;
  if (FAILED(enumerator->EnumAudioEndpoints(
          eRender, DEVICE_STATE_ACTIVE, devices.GetAddressOf()))) return false;
  UINT count = 0;
  if (FAILED(devices->GetCount(&count))) return false;
  std::size_t matches = 0;
  for (UINT index = 0; index < count; ++index) {
    ComPtr<IMMDevice> device;
    if (FAILED(devices->Item(index, device.GetAddressOf()))) return false;
    if (cpv::windows::isPersonaVoiceSink(device.Get())) ++matches;
  }
  *output = matches;
  return true;
}

int install(const DriverPackage& package,
            std::string_view readyAction = "install") {
  if (!elevated()) return fail("elevation_required", "Driver installation requires an elevated process");

  DeviceInfoSet existing(SetupDiGetClassDevsW(
      nullptr, nullptr, nullptr, DIGCF_ALLCLASSES | DIGCF_PRESENT));
  if (!existing) return fail("device_enumeration_failed", win32Message(GetLastError()));
  bool complete = false;
  const std::vector<OwnedDevice> before = ownedDevices(existing.get(), &complete);
  if (!complete) return fail("device_enumeration_failed", win32Message(GetLastError()));
  std::size_t sinksBefore = 0;
  if (!installedSinkCount(&sinksBefore)) {
    return fail("endpoint_enumeration_failed", "Windows could not enumerate active render endpoints");
  }
  if (before.size() == 1 && sinksBefore == 1) {
    return fail(
        "driver_already_installed",
        "Persona Voice Sink is already installed; verify it or uninstall before replacing it");
  }
  if (!before.empty() || sinksBefore != 0) {
    return fail(
        "existing_driver_conflict",
        "A partial or duplicate Persona Voice Sink installation exists; uninstall it before reinstalling");
  }

  StagedInf staged;
  if (!stageInf(package, &staged)) {
    return fail("driver_stage_failed", "Windows rejected the signed driver package: " +
        win32Message(GetLastError()));
  }

  DeviceInfoSet created;
  SP_DEVINFO_DATA createdDevice{};
  if (!createRootDevice(package.inf, &created, &createdDevice)) {
    const DWORD error = GetLastError();
    const bool rollback = rollbackStagedInf(staged);
    return fail(
        rollback ? "driver_device_creation_failed" : "driver_install_rollback_failed",
        "Creating the Persona Voice root device failed: " + win32Message(error) +
            (rollback ? "" : "; staged INF rollback also failed"));
  }

  BOOL reboot = FALSE;
  if (!UpdateDriverForPlugAndPlayDevicesW(
          nullptr, kHardwareId, package.inf.c_str(), INSTALLFLAG_FORCE, &reboot)) {
    const DWORD error = GetLastError();
    bool rollbackReboot = false;
    const bool removed = removeDevice(created.get(), &createdDevice, &rollbackReboot);
    const bool unstaged = removed && rollbackStagedInf(staged);
    return fail(
        unstaged ? "driver_update_failed" : "driver_install_rollback_failed",
        "Installing the Persona Voice Sink driver failed: " + win32Message(error) +
            (unstaged ? "" : "; device/INF rollback was not proven"));
  }

  if (reboot == FALSE) {
    std::size_t sinkCount = 0;
    bool endpointEnumerationComplete = installedSinkCount(&sinkCount);
    for (int attempt = 0;
         attempt < 100 && endpointEnumerationComplete && sinkCount != 1;
         ++attempt) {
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
      endpointEnumerationComplete = installedSinkCount(&sinkCount);
    }
    if (!endpointEnumerationComplete || sinkCount != 1) {
      bool rollbackReboot = false;
      const bool removed = removeDevice(created.get(), &createdDevice, &rollbackReboot);
      const bool unstaged = removed && rollbackStagedInf(staged);
      return fail(
          unstaged ? "driver_endpoint_missing" : "driver_install_rollback_failed",
          "Windows installed the package but did not expose exactly one Persona Voice Sink" +
              std::string(unstaged ? "" : "; device/INF rollback was not proven"));
    }
  }
  const std::optional<bool> changed = readyAction == "ensure-installed"
      ? std::optional<bool>(true) : std::nullopt;
  return emitReady(readyAction, true, reboot != FALSE, true, changed) ? 0 : 1;
}

int selfTest() {
  DeviceInfoSet devices(SetupDiGetClassDevsW(
      nullptr, nullptr, nullptr, DIGCF_ALLCLASSES | DIGCF_PRESENT));
  if (!devices) return fail("device_enumeration_failed", win32Message(GetLastError()));
  bool complete = false;
  const std::vector<OwnedDevice> owned = ownedDevices(devices.get(), &complete);
  if (!complete) return fail("device_enumeration_failed", win32Message(GetLastError()));
  std::size_t sinkCount = 0;
  if (!installedSinkCount(&sinkCount)) {
    return fail("endpoint_enumeration_failed", "Windows could not enumerate active render endpoints");
  }
  if (owned.empty() && sinkCount == 0) {
    return emitReady("self-test", false, false, true) ? 0 : 1;
  }
  if (owned.size() != 1 || owned.front().driverInfName.empty() || sinkCount != 1) {
    return fail(
        "existing_driver_conflict",
        "The installed ROOT\\CPVAudioSink device and marker-backed endpoint do not form one complete owned installation");
  }
  return emitReady("self-test", true, false, true) ? 0 : 1;
}

int ensureInstalled(const DriverPackage& package) {
  if (!elevated()) {
    return fail("elevation_required", "Driver installation requires an elevated process");
  }
  DeviceInfoSet devices(SetupDiGetClassDevsW(
      nullptr, nullptr, nullptr, DIGCF_ALLCLASSES | DIGCF_PRESENT));
  if (!devices) return fail("device_enumeration_failed", win32Message(GetLastError()));
  bool complete = false;
  const std::vector<OwnedDevice> owned = ownedDevices(devices.get(), &complete);
  if (!complete) return fail("device_enumeration_failed", win32Message(GetLastError()));
  std::size_t sinkCount = 0;
  if (!installedSinkCount(&sinkCount)) {
    return fail("endpoint_enumeration_failed", "Windows could not enumerate active render endpoints");
  }
  if (owned.size() == 1 && !owned.front().driverInfName.empty() && sinkCount == 1) {
    return emitReady("ensure-installed", true, false, true, false) ? 0 : 1;
  }
  if (!owned.empty() || sinkCount != 0) {
    return fail(
        "existing_driver_conflict",
        "A partial or duplicate Persona Voice Sink installation exists; uninstall it before reinstalling");
  }
  return install(package, "ensure-installed");
}

int uninstall() {
  if (!elevated()) return fail("elevation_required", "Driver removal requires an elevated process");
  DeviceInfoSet devices(SetupDiGetClassDevsW(
      nullptr, nullptr, nullptr, DIGCF_ALLCLASSES | DIGCF_PRESENT));
  if (!devices) return fail("device_enumeration_failed", win32Message(GetLastError()));
  bool complete = false;
  std::vector<OwnedDevice> owned = ownedDevices(devices.get(), &complete);
  if (!complete) return fail("device_enumeration_failed", win32Message(GetLastError()));
  if (owned.empty()) {
    std::size_t sinkCount = 0;
    if (!installedSinkCount(&sinkCount)) {
      return fail("endpoint_enumeration_failed", "Windows could not enumerate active render endpoints");
    }
    if (sinkCount != 0) {
      return fail(
          "driver_identity_unproven",
          "A Persona Voice Sink marker exists without the owned ROOT\\CPVAudioSink device");
    }
    return emitReady("uninstall", false, false, false) ? 0 : 1;
  }

  std::set<std::wstring> infNames;
  bool rebootRequired = false;
  for (OwnedDevice& device : owned) {
    if (device.driverInfName.empty()) {
      return fail("driver_identity_unproven", "Windows did not expose the installed driver INF identity");
    }
    infNames.insert(device.driverInfName);
    if (!removeDevice(devices.get(), &device.data, &rebootRequired)) {
      return fail("driver_device_removal_failed", win32Message(GetLastError()));
    }
  }
  for (const std::wstring& infName : infNames) {
    if (!SetupUninstallOEMInfW(infName.c_str(), SUOI_FORCEDELETE, nullptr)) {
      return fail(
          "driver_store_removal_failed",
          "The endpoint was removed but Windows could not remove " +
              cpv::windows::utf8FromWide(infName) + " from Driver Store: " +
              win32Message(GetLastError()));
    }
  }
  return emitReady("uninstall", false, rebootRequired, false) ? 0 : 1;
}

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
  enum class Action { None, SelfTest, EnsureInstalled, Install, Uninstall };
  Action action = Action::None;
  bool installerMode = false;
  bool invalid = false;
  for (int index = 1; index < argc; ++index) {
    const std::wstring_view argument(argv[index]);
    if (argument == L"--self-test" && action == Action::None) action = Action::SelfTest;
    else if (argument == L"--ensure-installed" && action == Action::None) action = Action::EnsureInstalled;
    else if (argument == L"--install" && action == Action::None) action = Action::Install;
    else if (argument == L"--uninstall" && action == Action::None) action = Action::Uninstall;
    else if (argument == L"--installer-mode" && !installerMode) installerMode = true;
    else invalid = true;
  }
  suppressProtocolOutput = installerMode;
  if (!installerMode && !cpv::windows::setBinaryStandardStreams(false)) return 1;
  if (!embeddedElevationManifest()) {
    return fail(
        "elevation_manifest_missing",
        "The driver manager executable is missing its requireAdministrator manifest");
  }
  const HRESULT comResult = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(comResult)) {
    return fail("com_initialization_failed", cpv::windows::hresultMessage(comResult));
  }

  int exitCode = 0;
  if (invalid || action == Action::None ||
      (installerMode && action != Action::EnsureInstalled && action != Action::Uninstall)) {
    exitCode = fail(
        "invalid_arguments",
        "Use exactly one action; --installer-mode is allowed only with --ensure-installed or --uninstall");
  } else if (action == Action::Uninstall) {
    exitCode = uninstall();
  } else {
    DriverPackage package;
    std::string packageError;
    if (!resolvePackage(&package, &packageError)) {
      exitCode = fail("driver_package_invalid", packageError);
    } else {
      const HRESULT trust = verifyCatalog(package.catalog);
      if (FAILED(trust)) {
        exitCode = fail(
            "driver_catalog_untrusted",
            "The Persona Voice Sink catalog is not trusted: " +
                cpv::windows::hresultMessage(trust));
      } else if (!catalogContainsFile(package.catalog, package.inf) ||
                 !catalogContainsFile(package.catalog, package.driver)) {
        exitCode = fail(
            "driver_package_not_catalog_bound",
            "PersonaVoiceSink.inf and cpv-audio-sink.sys must both be members of the trusted catalog");
      } else if (action == Action::SelfTest) {
        exitCode = selfTest();
      } else if (action == Action::EnsureInstalled) {
        exitCode = ensureInstalled(package);
      } else {
        exitCode = install(package);
      }
    }
  }

  CoUninitialize();
  return exitCode;
}
