#include "WindowsAudioCommon.hpp"

#include <audioclientactivationparams.h>
#include <wrl.h>
#include <wrl/implements.h>

#include <atomic>
#include <chrono>
#include <cstring>
#include <memory>
#include <sstream>
#include <string>
#include <thread>

namespace {

using cpv::windows::ComPtr;
using cpv::windows::ScopedHandle;

constexpr std::uint32_t kSampleRate = 48'000;
constexpr std::uint16_t kChannels = 2;
constexpr std::uint32_t kMinimumWindowsBuild = 20'348;
constexpr DWORD kActivationTimeoutMilliseconds = 10'000;

std::atomic<bool> stopRequested{false};
HANDLE stopEvent = nullptr;

void requestStop(DWORD) {
  stopRequested.store(true, std::memory_order_release);
  if (stopEvent != nullptr) SetEvent(stopEvent);
}

BOOL WINAPI consoleControlHandler(DWORD controlType) {
  switch (controlType) {
    case CTRL_C_EVENT:
    case CTRL_BREAK_EVENT:
    case CTRL_CLOSE_EVENT:
    case CTRL_LOGOFF_EVENT:
    case CTRL_SHUTDOWN_EVENT:
      requestStop(controlType);
      return TRUE;
    default:
      return FALSE;
  }
}

struct RuntimeVersionInfo {
  ULONG size;
  ULONG major;
  ULONG minor;
  ULONG build;
  ULONG platform;
  WCHAR servicePack[128];
};

std::uint32_t windowsBuild() {
  const HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  if (ntdll == nullptr) return 0;
  using RtlGetVersionFunction = LONG(WINAPI*)(RuntimeVersionInfo*);
  const auto getVersion = reinterpret_cast<RtlGetVersionFunction>(
      GetProcAddress(ntdll, "RtlGetVersion"));
  if (getVersion == nullptr) return 0;
  RuntimeVersionInfo version{};
  version.size = sizeof(version);
  return getVersion(&version) == 0 ? version.build : 0;
}

class ActivationHandler final
    : public Microsoft::WRL::RuntimeClass<
          Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,
          Microsoft::WRL::FtmBase,
          IActivateAudioInterfaceCompletionHandler> {
 public:
  ActivationHandler() : completed_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {}

  IFACEMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
    HRESULT activationResult = E_UNEXPECTED;
    ComPtr<IUnknown> activated;
    HRESULT result = operation == nullptr
        ? E_POINTER
        : operation->GetActivateResult(&activationResult, activated.GetAddressOf());
    if (SUCCEEDED(result)) result = activationResult;
    if (SUCCEEDED(result)) result = activated.As(&client_);
    result_ = result;
    if (completed_) SetEvent(completed_.get());
    return S_OK;
  }

  HRESULT wait(ComPtr<IAudioClient>* output) {
    if (!completed_ || output == nullptr) return E_POINTER;
    const DWORD waitResult = WaitForSingleObject(completed_.get(), kActivationTimeoutMilliseconds);
    if (waitResult == WAIT_TIMEOUT) return HRESULT_FROM_WIN32(ERROR_TIMEOUT);
    if (waitResult != WAIT_OBJECT_0) return HRESULT_FROM_WIN32(GetLastError());
    if (SUCCEEDED(result_)) *output = client_;
    return result_;
  }

 private:
  ScopedHandle completed_;
  HRESULT result_{E_PENDING};
  ComPtr<IAudioClient> client_;
};

HRESULT activateProcessLoopback(DWORD processId, ComPtr<IAudioClient>* client) {
  AUDIOCLIENT_ACTIVATION_PARAMS parameters{};
  parameters.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  parameters.ProcessLoopbackParams.TargetProcessId = processId;
  parameters.ProcessLoopbackParams.ProcessLoopbackMode =
      PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;

  PROPVARIANT activationParameters;
  PropVariantInit(&activationParameters);
  activationParameters.vt = VT_BLOB;
  activationParameters.blob.cbSize = sizeof(parameters);
  activationParameters.blob.pBlobData = reinterpret_cast<BYTE*>(&parameters);

  const auto handler = Microsoft::WRL::Make<ActivationHandler>();
  if (!handler) return E_OUTOFMEMORY;
  ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
  HRESULT result = ActivateAudioInterfaceAsync(
      VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
      __uuidof(IAudioClient),
      &activationParameters,
      handler.Get(),
      operation.GetAddressOf());
  if (FAILED(result)) return result;
  return handler->wait(client);
}

bool emitReady(DWORD processId, bool selfTest) {
  std::ostringstream json;
  json << "{\"type\":\"ready\",\"helper\":\"capture\",\"protocolVersion\":1"
       << ",\"backend\":\"wasapi-process-loopback\""
       << ",\"minimumWindowsBuild\":" << kMinimumWindowsBuild
       << ",\"windowsBuild\":" << windowsBuild()
       << ",\"sampleRate\":" << kSampleRate
       << ",\"channels\":" << kChannels
       << ",\"sampleFormat\":\"f32le\""
       << ",\"supportsProcessTreeCapture\":true"
       << ",\"supportsCaptureProof\":true"
       << ",\"supportsSuppression\":false"
       << ",\"suppressionBoundary\":\"owned-virtual-endpoint-required\""
       << ",\"selfTest\":" << (selfTest ? "true" : "false");
  if (!selfTest) json << ",\"rootPid\":" << processId;
  json << "}";
  return cpv::windows::writeJSON(cpv::FrameType::Ready, json.str());
}

int fail(std::string_view code, std::string_view message) {
  cpv::windows::writeError(code, message, true, false);
  return 1;
}

int failHRESULT(std::string_view code, std::string_view operation, HRESULT result) {
  return fail(code, std::string(operation) + " failed: " + cpv::windows::hresultMessage(result));
}

int capture(DWORD processId) {
  ScopedHandle process(OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                                   FALSE, processId));
  if (!process) {
    return fail("source_process_missing", "The selected Windows process is not running or cannot be queried");
  }

  ComPtr<IAudioClient> audioClient;
  HRESULT result = activateProcessLoopback(processId, &audioClient);
  if (FAILED(result)) {
    return failHRESULT("wasapi_process_loopback_activation_failed",
                       "WASAPI process-loopback activation", result);
  }

  WAVEFORMATEX format{};
  format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
  format.nChannels = kChannels;
  format.nSamplesPerSec = kSampleRate;
  format.wBitsPerSample = 32;
  format.nBlockAlign = static_cast<WORD>(format.nChannels * sizeof(float));
  format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;

  constexpr DWORD streamFlags = AUDCLNT_STREAMFLAGS_LOOPBACK |
      AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
      AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
      AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
  result = audioClient->Initialize(
      AUDCLNT_SHAREMODE_SHARED, streamFlags, 0, 0, &format, nullptr);
  if (FAILED(result)) {
    return failHRESULT("wasapi_process_loopback_initialization_failed",
                       "WASAPI process-loopback initialization", result);
  }

  ScopedHandle sampleReady(CreateEventW(nullptr, FALSE, FALSE, nullptr));
  if (!sampleReady) return fail("capture_event_failed", "The Windows capture event could not be created");
  result = audioClient->SetEventHandle(sampleReady.get());
  if (FAILED(result)) return failHRESULT("capture_event_failed", "WASAPI SetEventHandle", result);

  ComPtr<IAudioCaptureClient> captureClient;
  result = audioClient->GetService(IID_PPV_ARGS(captureClient.GetAddressOf()));
  if (FAILED(result)) {
    return failHRESULT("capture_service_failed", "WASAPI capture service acquisition", result);
  }

  result = audioClient->Start();
  if (FAILED(result)) return failHRESULT("capture_start_failed", "WASAPI capture start", result);
  if (!emitReady(processId, false)) {
    audioClient->Stop();
    return 1;
  }

  std::uint32_t sequence = 0;
  HANDLE waitHandles[] = {stopEvent, process.get(), sampleReady.get()};
  int exitCode = 0;
  while (!stopRequested.load(std::memory_order_acquire)) {
    const DWORD waitResult = WaitForMultipleObjects(3, waitHandles, FALSE, INFINITE);
    if (waitResult == WAIT_OBJECT_0) break;
    if (waitResult == WAIT_OBJECT_0 + 1) {
      fail("source_process_exited", "The selected Windows process exited during capture");
      exitCode = 1;
      break;
    }
    if (waitResult != WAIT_OBJECT_0 + 2) {
      fail("capture_wait_failed", "Waiting for Windows capture data failed");
      exitCode = 1;
      break;
    }

    UINT32 packetFrames = 0;
    result = captureClient->GetNextPacketSize(&packetFrames);
    if (FAILED(result)) {
      failHRESULT("capture_packet_query_failed", "WASAPI GetNextPacketSize", result);
      exitCode = 1;
      break;
    }
    while (packetFrames > 0) {
      BYTE* raw = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      UINT64 devicePosition = 0;
      UINT64 qpcPosition = 0;
      result = captureClient->GetBuffer(
          &raw, &frames, &flags, &devicePosition, &qpcPosition);
      if (FAILED(result)) {
        failHRESULT("capture_buffer_failed", "WASAPI GetBuffer", result);
        exitCode = 1;
        break;
      }

      if ((flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) != 0) {
        captureClient->ReleaseBuffer(frames);
        fail("capture_discontinuity", "WASAPI reported a process-loopback discontinuity");
        exitCode = 1;
        break;
      }
      if ((flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) != 0) {
        captureClient->ReleaseBuffer(frames);
        fail("capture_timestamp_error", "WASAPI could not prove the process-loopback timestamp");
        exitCode = 1;
        break;
      }
      if (frames == 0 || frames > cpv::kMaximumPayloadBytes /
              (sizeof(float) * static_cast<std::uint32_t>(kChannels))) {
        captureClient->ReleaseBuffer(frames);
        fail("capture_frame_bounds", "WASAPI returned an out-of-bounds process-loopback packet");
        exitCode = 1;
        break;
      }

      const std::size_t pcmBytes = static_cast<std::size_t>(frames) * kChannels * sizeof(float);
      std::vector<std::uint8_t> payload(sizeof(cpv::AudioMetadata) + pcmBytes, 0);
      cpv::AudioMetadata metadata{
          sequence++,
          kSampleRate,
          kChannels,
          static_cast<std::uint16_t>(cpv::SampleFormat::Float32LittleEndian),
          frames,
      };
      std::memcpy(payload.data(), &metadata, sizeof(metadata));
      if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) == 0 && raw != nullptr) {
        std::memcpy(payload.data() + sizeof(metadata), raw, pcmBytes);
      }
      result = captureClient->ReleaseBuffer(frames);
      if (FAILED(result)) {
        failHRESULT("capture_release_failed", "WASAPI ReleaseBuffer", result);
        exitCode = 1;
        break;
      }
      if (!cpv::writeFrame(
              stdout, cpv::FrameType::Audio, payload.data(),
              static_cast<std::uint32_t>(payload.size()))) {
        exitCode = 1;
        break;
      }
      result = captureClient->GetNextPacketSize(&packetFrames);
      if (FAILED(result)) {
        failHRESULT("capture_packet_query_failed", "WASAPI GetNextPacketSize", result);
        exitCode = 1;
        break;
      }
    }
    if (exitCode != 0) break;
  }

  result = audioClient->Stop();
  if (FAILED(result) && exitCode == 0) {
    failHRESULT("capture_stop_failed", "WASAPI capture stop", result);
    exitCode = 1;
  }
  return exitCode;
}

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
  if (!cpv::windows::setBinaryStandardStreams(false)) return 1;
  const HRESULT comResult = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(comResult)) return failHRESULT("com_initialization_failed", "COM initialization", comResult);

  ScopedHandle ownedStopEvent(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  if (!ownedStopEvent) {
    CoUninitialize();
    return fail("capture_event_failed", "The Windows stop event could not be created");
  }
  stopEvent = ownedStopEvent.get();
  SetConsoleCtrlHandler(consoleControlHandler, TRUE);

  bool selfTest = false;
  std::uint32_t processId = 0;
  bool invalid = false;
  for (int index = 1; index < argc; ++index) {
    const std::wstring_view argument(argv[index]);
    if (argument == L"--self-test") {
      selfTest = true;
    } else if (argument == L"--root-pid" && index + 1 < argc) {
      const std::string utf8 = cpv::windows::utf8FromWide(argv[++index]);
      invalid = !cpv::windows::parseUnsigned(
          utf8, 1, std::numeric_limits<DWORD>::max(), &processId);
    } else {
      invalid = true;
    }
  }

  int exitCode = 0;
  const std::uint32_t build = windowsBuild();
  if (invalid || (!selfTest && processId == 0)) {
    exitCode = fail("invalid_arguments", "Use --self-test or --root-pid <positive process id>");
  } else if (build < kMinimumWindowsBuild) {
    std::ostringstream message;
    message << "WASAPI process-loopback capture requires Windows build "
            << kMinimumWindowsBuild << " or newer; this system reports build " << build;
    exitCode = fail("windows_build_unsupported", message.str());
  } else if (selfTest) {
    exitCode = emitReady(0, true) ? 0 : 1;
  } else {
    exitCode = capture(processId);
  }

  SetConsoleCtrlHandler(consoleControlHandler, FALSE);
  stopEvent = nullptr;
  CoUninitialize();
  return exitCode;
}
