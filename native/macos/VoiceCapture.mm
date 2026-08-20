#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>
#import <CoreAudio/CoreAudio.h>
#import <Foundation/Foundation.h>

#include "../shared/NativeProtocol.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cerrno>
#include <cstdint>
#include <csignal>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#include <libproc.h>
#include <unistd.h>

namespace {

constexpr std::size_t kRingCapacity = 64;
constexpr std::size_t kMaximumChannels = 2;
constexpr std::size_t kMaximumFramesPerChunk = 8192;
constexpr float kVoiceActivationPeak = 0.0005f;
constexpr auto kInputStopGrace = std::chrono::milliseconds(750);
constexpr auto kFirstFrameDeadline = std::chrono::milliseconds(1500);

std::atomic<bool> stopRequested{false};
std::mutex stdoutMutex;

AudioObjectPropertyAddress propertyAddress(
    AudioObjectPropertySelector selector,
    AudioObjectPropertyScope scope = kAudioObjectPropertyScopeGlobal,
    AudioObjectPropertyElement element = kAudioObjectPropertyElementMain) {
  return {selector, scope, element};
}

bool emitJSON(cpv::FrameType type, NSDictionary* object) {
  NSError* error = nil;
  NSData* data = [NSJSONSerialization dataWithJSONObject:object options:0 error:&error];
  if (data == nil || data.length > cpv::kMaximumPayloadBytes) return false;
  const std::lock_guard<std::mutex> lock(stdoutMutex);
  return cpv::writeFrame(
      stdout,
      type,
      data.bytes,
      static_cast<std::uint32_t>(data.length));
}

bool anyProcessDirectionRunning(
    const std::vector<AudioObjectID>& processObjects,
    AudioObjectPropertySelector selector) {
  auto address = propertyAddress(selector);
  for (AudioObjectID object : processObjects) {
    UInt32 running = 0;
    UInt32 size = sizeof(running);
    if (AudioObjectGetPropertyData(object, &address, 0, nullptr, &size, &running) == noErr &&
        running != 0) {
      return true;
    }
  }
  return false;
}

bool anyProcessInputRunning(const std::vector<AudioObjectID>& processObjects) {
  return anyProcessDirectionRunning(processObjects, kAudioProcessPropertyIsRunningInput);
}

bool anyProcessOutputRunning(const std::vector<AudioObjectID>& processObjects) {
  return anyProcessDirectionRunning(processObjects, kAudioProcessPropertyIsRunningOutput);
}

OSStatus setTapMuteBehavior(
    AudioObjectID tapID,
    CATapDescription* tapDescription,
    CATapMuteBehavior behavior) {
  tapDescription.muteBehavior = behavior;
  CFTypeRef description = (__bridge CFTypeRef)tapDescription;
  UInt32 size = sizeof(description);
  auto address = propertyAddress(kAudioTapPropertyDescription);
  return AudioObjectSetPropertyData(tapID, &address, 0, nullptr, size, &description);
}

int fail(NSString* message, OSStatus status = noErr) {
  NSString* detail = status == noErr
      ? message
      : [NSString stringWithFormat:@"%@ (OSStatus %d)", message, status];
  emitJSON(cpv::FrameType::Error, @{
    @"type" : @"error",
    @"code" : @"capture_initialization_failed",
    @"message" : detail,
    @"suppressionHeld" : @NO,
  });
  return 1;
}

void handleSignal(int) {
  stopRequested.store(true, std::memory_order_release);
}

bool processAlive(pid_t pid) {
  if (pid <= 0) return false;
  if (kill(pid, 0) == 0) return true;
  return errno == EPERM;
}

bool anyProcessAlive(const std::vector<pid_t>& processIds) {
  return std::any_of(processIds.begin(), processIds.end(), processAlive);
}

std::vector<pid_t> directChildProcesses(pid_t parentPid) {
  const int capacityHint = proc_listchildpids(parentPid, nullptr, 0);
  if (capacityHint <= 0) return {};
  std::vector<pid_t> children(static_cast<std::size_t>(capacityHint));
  const int count = proc_listchildpids(
      parentPid,
      children.data(),
      static_cast<int>(children.size() * sizeof(pid_t)));
  if (count <= 0) return {};
  children.resize(std::min(children.size(), static_cast<std::size_t>(count)));
  children.erase(
      std::remove_if(children.begin(), children.end(), [](pid_t pid) { return pid <= 0; }),
      children.end());
  return children;
}

std::string processExecutablePath(pid_t pid) {
  std::array<char, PROC_PIDPATHINFO_MAXSIZE> path{};
  const int length = proc_pidpath(pid, path.data(), static_cast<std::uint32_t>(path.size()));
  return length > 0 ? std::string(path.data(), static_cast<std::size_t>(length)) : std::string{};
}

std::string applicationBundlePrefix(pid_t rootPid) {
  const std::string path = processExecutablePath(rootPid);
  const std::size_t marker = path.find(".app/");
  return marker == std::string::npos ? std::string{} : path.substr(0, marker + 5);
}

bool belongsToApplicationBundle(pid_t pid, pid_t rootPid, const std::string& bundlePrefix) {
  if (pid == rootPid || bundlePrefix.empty()) return true;
  const std::string path = processExecutablePath(pid);
  if (!path.starts_with(bundlePrefix)) return false;
  return path.substr(bundlePrefix.size()).find(".app/Contents/MacOS/") != std::string::npos;
}

std::vector<pid_t> dynamicProcessTree(const std::vector<pid_t>& rootProcessIds) {
  std::vector<pid_t> tree;
  tree.reserve(rootProcessIds.size() + 16);
  for (pid_t rootPid : rootProcessIds) {
    if (!processAlive(rootPid)) continue;
    const std::string bundlePrefix = applicationBundlePrefix(rootPid);
    std::vector<pid_t> branch{rootPid};
    for (std::size_t index = 0; index < branch.size(); ++index) {
      for (pid_t childPid : directChildProcesses(branch[index])) {
        if (std::find(branch.begin(), branch.end(), childPid) == branch.end()) {
          branch.push_back(childPid);
        }
      }
    }
    for (pid_t pid : branch) {
      if (belongsToApplicationBundle(pid, rootPid, bundlePrefix) &&
          std::find(tree.begin(), tree.end(), pid) == tree.end()) {
        tree.push_back(pid);
      }
    }
  }
  return tree;
}

std::vector<AudioObjectID> audioProcessObjects(
    const std::vector<pid_t>& requestedPids,
    std::vector<pid_t>* resolvedPids = nullptr) {
  auto address = propertyAddress(kAudioHardwarePropertyProcessObjectList);
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(
          kAudioObjectSystemObject, &address, 0, nullptr, &size) != noErr) {
    return {};
  }
  std::vector<AudioObjectID> objects(size / sizeof(AudioObjectID));
  if (objects.empty() || AudioObjectGetPropertyData(
          kAudioObjectSystemObject, &address, 0, nullptr, &size, objects.data()) != noErr) {
    return {};
  }
  objects.resize(size / sizeof(AudioObjectID));

  std::vector<AudioObjectID> matches;
  for (AudioObjectID object : objects) {
    auto pidAddress = propertyAddress(kAudioProcessPropertyPID);
    pid_t pid = 0;
    UInt32 pidSize = sizeof(pid);
    if (AudioObjectGetPropertyData(object, &pidAddress, 0, nullptr, &pidSize, &pid) != noErr) continue;
    if (std::find(requestedPids.begin(), requestedPids.end(), pid) == requestedPids.end()) continue;
    matches.push_back(object);
    if (resolvedPids != nullptr) resolvedPids->push_back(pid);
  }
  return matches;
}

bool defaultCaptureFormat(std::uint32_t* sampleRate, std::uint16_t* channels) {
  AudioObjectID device = kAudioObjectUnknown;
  UInt32 deviceSize = sizeof(device);
  auto defaultAddress = propertyAddress(kAudioHardwarePropertyDefaultOutputDevice);
  if (AudioObjectGetPropertyData(
          kAudioObjectSystemObject, &defaultAddress, 0, nullptr, &deviceSize, &device) != noErr ||
      device == kAudioObjectUnknown) {
    return false;
  }
  AudioStreamBasicDescription format{};
  UInt32 formatSize = sizeof(format);
  auto formatAddress = propertyAddress(
      kAudioDevicePropertyStreamFormat, kAudioDevicePropertyScopeOutput);
  if (AudioObjectGetPropertyData(
          device, &formatAddress, 0, nullptr, &formatSize, &format) != noErr ||
      format.mSampleRate <= 0) {
    return false;
  }
  *sampleRate = static_cast<std::uint32_t>(std::llround(format.mSampleRate));
  *channels = 2;  // VoiceCapture requests a stereo mixdown regardless of hardware channel layout.
  return true;
}

bool supportedPCMFormat(const AudioStreamBasicDescription& format) {
  if (format.mFormatID != kAudioFormatLinearPCM || format.mChannelsPerFrame == 0 ||
      format.mChannelsPerFrame > kMaximumChannels || format.mSampleRate < 8000 ||
      format.mSampleRate > 192000 || format.mBytesPerFrame == 0 ||
      (format.mFormatFlags & kAudioFormatFlagIsPacked) == 0 ||
      (format.mFormatFlags & kAudioFormatFlagIsBigEndian) != 0) {
    return false;
  }
  const bool isFloat = (format.mFormatFlags & kAudioFormatFlagIsFloat) != 0;
  const bool isSigned = (format.mFormatFlags & kAudioFormatFlagIsSignedInteger) != 0;
  return (isFloat && (format.mBitsPerChannel == 32 || format.mBitsPerChannel == 64)) ||
         (isSigned && (format.mBitsPerChannel == 16 || format.mBitsPerChannel == 32));
}

float normalizedSample(const AudioBuffer& buffer, std::size_t sampleIndex,
                       const AudioStreamBasicDescription& format) {
  if (buffer.mData == nullptr) return 0.0f;
  const bool isFloat = (format.mFormatFlags & kAudioFormatFlagIsFloat) != 0;
  if (isFloat && format.mBitsPerChannel == 32) {
    const float sample = static_cast<const float*>(buffer.mData)[sampleIndex];
    return std::isfinite(sample) ? sample : 0.0f;
  }
  if (isFloat && format.mBitsPerChannel == 64) {
    const double sample = static_cast<const double*>(buffer.mData)[sampleIndex];
    return std::isfinite(sample) ? static_cast<float>(sample) : 0.0f;
  }
  if (format.mBitsPerChannel == 16) {
    return static_cast<float>(static_cast<const std::int16_t*>(buffer.mData)[sampleIndex]) / 32768.0f;
  }
  return static_cast<float>(static_cast<const std::int32_t*>(buffer.mData)[sampleIndex]) / 2147483648.0f;
}

std::size_t availableFrames(const AudioBufferList* input,
                            const AudioStreamBasicDescription& format) {
  if (input == nullptr || input->mNumberBuffers == 0) return 0;
  const std::size_t bytesPerSample = format.mBitsPerChannel / 8;
  if (bytesPerSample == 0) return 0;
  std::size_t frames = std::numeric_limits<std::size_t>::max();
  for (UInt32 index = 0; index < input->mNumberBuffers; ++index) {
    const AudioBuffer& buffer = input->mBuffers[index];
    const std::size_t channels = std::max<UInt32>(1, buffer.mNumberChannels);
    frames = std::min(frames, static_cast<std::size_t>(buffer.mDataByteSize) /
        (bytesPerSample * channels));
  }
  return frames == std::numeric_limits<std::size_t>::max() ? 0 : frames;
}

float sampleAt(const AudioBufferList* input,
               const AudioStreamBasicDescription& format,
               std::size_t frame,
               std::size_t channel) {
  std::size_t channelBase = 0;
  for (UInt32 index = 0; index < input->mNumberBuffers; ++index) {
    const AudioBuffer& buffer = input->mBuffers[index];
    const std::size_t bufferChannels = std::max<UInt32>(1, buffer.mNumberChannels);
    if (channel < channelBase + bufferChannels) {
      const std::size_t localChannel = channel - channelBase;
      return normalizedSample(buffer, frame * bufferChannels + localChannel, format);
    }
    channelBase += bufferChannels;
  }
  return 0.0f;
}

struct AudioSlot {
  std::uint64_t ordinal = 0;
  cpv::AudioMetadata metadata{};
  std::array<float, kMaximumFramesPerChunk * kMaximumChannels> samples{};
};

class AudioRing {
 public:
  explicit AudioRing(const AudioStreamBasicDescription& format) : format_(format) {}

  void push(const AudioBufferList* input) {
    if (faulted_.load(std::memory_order_acquire)) return;
    const std::size_t frames = availableFrames(input, format_);
    if (frames == 0) return;
    if (frames > kMaximumFramesPerChunk) {
      setFault("Core Audio produced an oversized PCM chunk");
      return;
    }
    const std::uint64_t write = writeIndex_.load(std::memory_order_relaxed);
    const std::uint64_t read = readIndex_.load(std::memory_order_acquire);
    if (write - read >= kRingCapacity) {
      setFault("The capture queue exceeded its bounded capacity");
      return;
    }

    AudioSlot& slot = slots_[write % kRingCapacity];
    slot.ordinal = write;
    const std::size_t channels = format_.mChannelsPerFrame;
    slot.metadata = {
        sequence_.fetch_add(1, std::memory_order_relaxed),
        static_cast<std::uint32_t>(std::llround(format_.mSampleRate)),
        static_cast<std::uint16_t>(channels),
        static_cast<std::uint16_t>(cpv::SampleFormat::Float32LittleEndian),
        static_cast<std::uint32_t>(frames),
    };
    float peak = 0.0f;
    for (std::size_t frame = 0; frame < frames; ++frame) {
      for (std::size_t channel = 0; channel < channels; ++channel) {
        const float sample = sampleAt(input, format_, frame, channel);
        slot.samples[frame * channels + channel] = sample;
        peak = std::max(peak, std::abs(sample));
      }
    }
    if (peak >= kVoiceActivationPeak) {
      audibleGeneration_.fetch_add(1, std::memory_order_release);
    }
    writeIndex_.store(write + 1, std::memory_order_release);
  }

  const AudioSlot* front() const {
    const std::uint64_t read = readIndex_.load(std::memory_order_relaxed);
    if (read >= writeIndex_.load(std::memory_order_acquire)) return nullptr;
    return &slots_[read % kRingCapacity];
  }

  void pop() {
    readIndex_.fetch_add(1, std::memory_order_release);
  }

  bool empty() const {
    return readIndex_.load(std::memory_order_acquire) >=
           writeIndex_.load(std::memory_order_acquire);
  }

  bool faulted() const { return faulted_.load(std::memory_order_acquire); }
  const char* faultMessage() const { return faultMessage_.load(std::memory_order_acquire); }
  std::uint64_t audibleGeneration() const {
    return audibleGeneration_.load(std::memory_order_acquire);
  }
  std::uint64_t nextOrdinal() const {
    return writeIndex_.load(std::memory_order_acquire);
  }

 private:
  void setFault(const char* message) {
    const char* expected = nullptr;
    if (faultMessage_.compare_exchange_strong(expected, message, std::memory_order_acq_rel)) {
      faulted_.store(true, std::memory_order_release);
    }
  }

  AudioStreamBasicDescription format_{};
  std::array<AudioSlot, kRingCapacity> slots_{};
  std::atomic<std::uint64_t> writeIndex_{0};
  std::atomic<std::uint64_t> readIndex_{0};
  std::atomic<std::uint32_t> sequence_{0};
  std::atomic<std::uint64_t> audibleGeneration_{0};
  std::atomic<const char*> faultMessage_{nullptr};
  std::atomic<bool> faulted_{false};
};

struct CaptureContext {
  AudioRing* ring;
};

OSStatus captureIOProc(
    AudioObjectID,
    const AudioTimeStamp*,
    const AudioBufferList* input,
    const AudioTimeStamp*,
    AudioBufferList*,
    const AudioTimeStamp*,
    void* clientData) {
  auto* context = static_cast<CaptureContext*>(clientData);
  if (context != nullptr && context->ring != nullptr && input != nullptr) context->ring->push(input);
  return noErr;
}

bool writeAudioSlot(const AudioSlot& slot) {
  const std::uint32_t pcmBytes = slot.metadata.samplesPerChannel *
      slot.metadata.channels * sizeof(float);
  const std::uint32_t payloadBytes = sizeof(cpv::AudioMetadata) + pcmBytes;
  const cpv::FrameHeader header{
      cpv::kFrameMagic,
      cpv::kProtocolVersion,
      static_cast<std::uint16_t>(cpv::FrameType::Audio),
      payloadBytes,
  };
  const std::lock_guard<std::mutex> lock(stdoutMutex);
  return cpv::writeBytes(stdout, &header, sizeof(header)) &&
         cpv::writeBytes(stdout, &slot.metadata, sizeof(slot.metadata)) &&
         cpv::writeBytes(stdout, slot.samples.data(), pcmBytes) &&
         fflush(stdout) == 0;
}

void writerLoop(
    AudioRing* ring,
    std::atomic<bool>* captureActive,
    std::atomic<bool>* streamEnabled,
    std::atomic<bool>* suppressionHeld,
    std::atomic<std::uint64_t>* minimumOutputOrdinal) {
  bool faultPublished = false;
  while (captureActive->load(std::memory_order_acquire) || !ring->empty()) {
    if (ring->faulted() && !faultPublished) {
      faultPublished = true;
      @autoreleasepool {
        const char* fault = ring->faultMessage();
        NSString* message = [NSString stringWithUTF8String:fault != nullptr ? fault : "Capture queue fault"];
        if (!emitJSON(cpv::FrameType::Error, @{
              @"type" : @"error",
              @"code" : @"capture_queue_fault",
              @"message" : message,
              @"suppressionHeld" : @(suppressionHeld->load(std::memory_order_acquire)),
            })) {
          stopRequested.store(true, std::memory_order_release);
          return;
        }
      }
    }
    const AudioSlot* slot = ring->front();
    if (slot == nullptr) {
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
      continue;
    }
    const bool shouldWrite = streamEnabled->load(std::memory_order_acquire) &&
        slot->ordinal >= minimumOutputOrdinal->load(std::memory_order_acquire);
    if (shouldWrite && !writeAudioSlot(*slot)) {
      stopRequested.store(true, std::memory_order_release);
      return;
    }
    ring->pop();
  }
}

class ActiveCapture {
 public:
  ActiveCapture() = default;
  ActiveCapture(const ActiveCapture&) = delete;
  ActiveCapture& operator=(const ActiveCapture&) = delete;

  ~ActiveCapture() {
    close();
  }

  bool start(
      const std::vector<AudioObjectID>& processObjects,
      std::uint32_t expectedSampleRate,
      std::uint16_t expectedChannels,
      NSString** failureMessage,
      OSStatus* failureStatus) {
    processObjects_ = processObjects;
    std::sort(processObjects_.begin(), processObjects_.end());
    processObjects_.erase(
        std::unique(processObjects_.begin(), processObjects_.end()),
        processObjects_.end());
    NSMutableArray<NSNumber*>* processNumbers =
        [NSMutableArray arrayWithCapacity:processObjects_.size()];
    for (AudioObjectID object : processObjects_) [processNumbers addObject:@(object)];

    tapDescription_ = [[CATapDescription alloc] initStereoMixdownOfProcesses:processNumbers];
    if (tapDescription_ == nil) {
      return failStart(@"Unable to configure the deferred Core Audio process tap.", noErr,
                       failureMessage, failureStatus);
    }
    tapDescription_.name = @"Codex Persona Voice active process tap";
    tapDescription_.UUID = NSUUID.UUID;
    tapDescription_.muteBehavior = CATapUnmuted;
    [tapDescription_ setPrivate:YES];

    OSStatus status = AudioHardwareCreateProcessTap(tapDescription_, &tapID_);
    if (status != noErr) {
      return failStart(@"Unable to create the deferred Core Audio process tap.", status,
                       failureMessage, failureStatus);
    }

    NSString* tapUID = tapDescription_.UUID.UUIDString;
    if (tapUID.length == 0) {
      return failStart(@"Unable to read the deferred Core Audio tap identifier.", noErr,
                       failureMessage, failureStatus);
    }

    NSString* aggregateUID = [NSString stringWithFormat:@"dev.miuuyy.codexpersonavoice.%@",
                                                        NSUUID.UUID.UUIDString];
    NSDictionary* tapEntry = @{
      @kAudioSubTapUIDKey : tapUID,
      @kAudioSubTapDriftCompensationKey : @YES,
    };
    NSDictionary* aggregateDescription = @{
      @kAudioAggregateDeviceNameKey : @"Codex Persona Voice Capture",
      @kAudioAggregateDeviceUIDKey : aggregateUID,
      @kAudioAggregateDeviceIsPrivateKey : @YES,
      @kAudioAggregateDeviceIsStackedKey : @NO,
      @kAudioAggregateDeviceTapListKey : @[ tapEntry ],
      @kAudioAggregateDeviceTapAutoStartKey : @NO,
    };
    status = AudioHardwareCreateAggregateDevice(
        (__bridge CFDictionaryRef)aggregateDescription, &aggregateID_);
    if (status != noErr) {
      return failStart(@"Unable to create a private Core Audio aggregate device.", status,
                       failureMessage, failureStatus);
    }

    Float64 aggregateSampleRate = expectedSampleRate;
    auto sampleRateAddress = propertyAddress(kAudioDevicePropertyNominalSampleRate);
    status = AudioObjectSetPropertyData(
        aggregateID_,
        &sampleRateAddress,
        0,
        nullptr,
        sizeof(aggregateSampleRate),
        &aggregateSampleRate);
    if (status != noErr) {
      return failStart(@"Unable to configure the capture route sample rate.", status,
                       failureMessage, failureStatus);
    }

    status = kAudioHardwareBadObjectError;
    const auto formatDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
    while (true) {
      auto formatAddress = propertyAddress(kAudioTapPropertyFormat);
      UInt32 formatSize = sizeof(format_);
      const OSStatus readStatus = AudioObjectGetPropertyData(
          tapID_, &formatAddress, 0, nullptr, &formatSize, &format_);
      if (readStatus == noErr && format_.mSampleRate > 0 && supportedPCMFormat(format_)) {
        status = noErr;
      } else {
        status = readStatus != noErr ? readStatus : kAudioHardwareUnsupportedOperationError;
      }
      if (status == noErr || std::chrono::steady_clock::now() >= formatDeadline) break;
      std::this_thread::sleep_for(std::chrono::milliseconds(25));
    }
    if (status != noErr) {
      return failStart(@"The tapped stream does not expose a supported linear PCM format.", status,
                       failureMessage, failureStatus);
    }
    const auto actualSampleRate =
        static_cast<std::uint32_t>(std::llround(format_.mSampleRate));
    if (actualSampleRate != expectedSampleRate ||
        format_.mChannelsPerFrame != expectedChannels) {
      return failStart([NSString stringWithFormat:
                           @"The active voice route changed the declared capture format "
                            "(expected %u Hz/%u ch, received %u Hz/%u ch).",
                           expectedSampleRate,
                           expectedChannels,
                           actualSampleRate,
                           format_.mChannelsPerFrame],
                       kAudioHardwareUnsupportedOperationError, failureMessage, failureStatus);
    }

    ring_ = std::make_unique<AudioRing>(format_);
    context_.ring = ring_.get();
    status = AudioDeviceCreateIOProcID(aggregateID_, captureIOProc, &context_, &ioProcID_);
    if (status == noErr) {
      captureActive_.store(true, std::memory_order_release);
      status = AudioDeviceStart(aggregateID_, ioProcID_);
      ioStarted_ = status == noErr;
    }
    if (status != noErr) {
      captureActive_.store(false, std::memory_order_release);
      return failStart(@"Unable to start deferred Core Audio capture.", status,
                       failureMessage, failureStatus);
    }

    writer_ = std::thread(
        writerLoop,
        ring_.get(),
        &captureActive_,
        &streamEnabled_,
        &suppressionHeld_,
        &minimumOutputOrdinal_);
    const auto firstFrameDeadline = std::chrono::steady_clock::now() + kFirstFrameDeadline;
    while (ring_->nextOrdinal() == 0 && !ring_->faulted() &&
           std::chrono::steady_clock::now() < firstFrameDeadline) {
      std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    if (ring_->faulted()) {
      return failStart(@"Deferred Core Audio capture faulted before its first PCM frame.", noErr,
                       failureMessage, failureStatus);
    }
    if (ring_->nextOrdinal() == 0) {
      return failStart(@"Deferred Core Audio process tap produced no PCM frames.", noErr,
                       failureMessage, failureStatus);
    }
    status = setTapMuteBehavior(tapID_, tapDescription_, CATapMutedWhenTapped);
    if (status != noErr) {
      return failStart(@"Unable to suppress the connected voice route.", status,
                       failureMessage, failureStatus);
    }
    suppressionHeld_.store(true, std::memory_order_release);
    return true;
  }

  void enableStreaming() {
    if (ring_ == nullptr || !suppressionHeld_.load(std::memory_order_acquire)) return;
    // The realtime callback may have begun a push before mute but not published writeIndex yet.
    // Skipping the next ordinal excludes that one possible in-flight pre-suppression slot.
    minimumOutputOrdinal_.store(ring_->nextOrdinal() + 1, std::memory_order_release);
    streamEnabled_.store(true, std::memory_order_release);
  }

  bool suppressionHeld() const {
    return suppressionHeld_.load(std::memory_order_acquire);
  }

  bool matchesProcessObjects(const std::vector<AudioObjectID>& processObjects) const {
    auto normalized = processObjects;
    std::sort(normalized.begin(), normalized.end());
    normalized.erase(std::unique(normalized.begin(), normalized.end()), normalized.end());
    return normalized == processObjects_;
  }

  OSStatus close() {
    streamEnabled_.store(false, std::memory_order_release);
    OSStatus restoreStatus = noErr;
    if (tapID_ != kAudioObjectUnknown && tapDescription_ != nil) {
      restoreStatus = setTapMuteBehavior(tapID_, tapDescription_, CATapUnmuted);
      if (restoreStatus == noErr) suppressionHeld_.store(false, std::memory_order_release);
    }
    if (ioStarted_) AudioDeviceStop(aggregateID_, ioProcID_);
    ioStarted_ = false;
    captureActive_.store(false, std::memory_order_release);
    if (writer_.joinable()) writer_.join();
    if (ioProcID_ != nullptr && aggregateID_ != kAudioObjectUnknown) {
      AudioDeviceDestroyIOProcID(aggregateID_, ioProcID_);
    }
    ioProcID_ = nullptr;
    if (aggregateID_ != kAudioObjectUnknown) AudioHardwareDestroyAggregateDevice(aggregateID_);
    aggregateID_ = kAudioObjectUnknown;
    if (tapID_ != kAudioObjectUnknown) AudioHardwareDestroyProcessTap(tapID_);
    tapID_ = kAudioObjectUnknown;
    tapDescription_ = nil;
    processObjects_.clear();
    ring_.reset();
    context_.ring = nullptr;
    return restoreStatus;
  }

 private:
  bool failStart(
      NSString* message,
      OSStatus status,
      NSString** failureMessage,
      OSStatus* failureStatus) {
    if (failureMessage != nullptr) *failureMessage = message;
    if (failureStatus != nullptr) *failureStatus = status;
    close();
    return false;
  }

  CATapDescription* tapDescription_ = nil;
  std::vector<AudioObjectID> processObjects_;
  AudioObjectID tapID_ = kAudioObjectUnknown;
  AudioObjectID aggregateID_ = kAudioObjectUnknown;
  AudioStreamBasicDescription format_{};
  std::unique_ptr<AudioRing> ring_;
  CaptureContext context_{nullptr};
  AudioDeviceIOProcID ioProcID_ = nullptr;
  std::atomic<bool> captureActive_{false};
  std::atomic<bool> streamEnabled_{false};
  std::atomic<std::uint64_t> minimumOutputOrdinal_{0};
  std::thread writer_;
  bool ioStarted_ = false;
  std::atomic<bool> suppressionHeld_{false};
};

}  // namespace

int main(int argc, const char* argv[]) {
  @autoreleasepool {
    signal(SIGPIPE, SIG_IGN);
    const pid_t ownerPid = getppid();
    std::vector<pid_t> rootProcessIds;
    for (int index = 1; index < argc; ++index) {
      if (strcmp(argv[index], "--self-test") == 0) {
        std::uint32_t sampleRate = 0;
        std::uint16_t channels = 0;
        if (!defaultCaptureFormat(&sampleRate, &channels)) {
          return fail(@"No default Core Audio output format is available.");
        }
        emitJSON(cpv::FrameType::Ready, @{
          @"type" : @"ready",
          @"helper" : @"capture",
          @"protocolVersion" : @(cpv::kProtocolVersion),
          @"sampleRate" : @(sampleRate),
          @"channels" : @(channels),
          @"sampleFormat" : @"f32le",
          @"supportsArming" : @YES,
          @"supportsDeferredTap" : @YES,
          @"supportsCaptureProof" : @YES,
        });
        return 0;
      }
      if (strcmp(argv[index], "--root-pid") == 0 && index + 1 < argc) {
        const long value = strtol(argv[++index], nullptr, 10);
        if (value > 0 && value <= std::numeric_limits<pid_t>::max()) {
          rootProcessIds.push_back(static_cast<pid_t>(value));
        }
      }
    }
    if (rootProcessIds.empty()) return fail(@"At least one --root-pid is required.");
    if (!anyProcessAlive(rootProcessIds)) {
      return fail(@"The selected application stopped before Core Audio capture began.");
    }

    std::vector<pid_t> initialResolvedPids;
    audioProcessObjects(dynamicProcessTree(rootProcessIds), &initialResolvedPids);
    std::uint32_t declaredSampleRate = 0;
    std::uint16_t declaredChannels = 0;
    if (!defaultCaptureFormat(&declaredSampleRate, &declaredChannels)) {
      return fail(@"No default Core Audio output format is available.");
    }
    signal(SIGINT, handleSignal);
    signal(SIGTERM, handleSignal);
    NSMutableArray<NSNumber*>* resolvedNumbers =
        [NSMutableArray arrayWithCapacity:initialResolvedPids.size()];
    for (pid_t pid : initialResolvedPids) [resolvedNumbers addObject:@(pid)];
    const bool readyWritten = emitJSON(cpv::FrameType::Ready, @{
      @"type" : @"ready",
      @"helper" : @"capture",
      @"protocolVersion" : @(cpv::kProtocolVersion),
      @"source" : @"macOS process audio",
      @"pids" : resolvedNumbers,
      @"sampleRate" : @(declaredSampleRate),
      @"channels" : @(declaredChannels),
      @"sampleFormat" : @"f32le",
      @"supportsArming" : @YES,
      @"supportsDeferredTap" : @YES,
      @"supportsCaptureProof" : @YES,
      @"armed" : @YES,
      @"state" : @"armed",
      @"originalSuppressed" : @NO,
      @"tapActive" : @NO,
      @"activationSignal" : @"duplex_process_io",
      @"ownerPid" : @(ownerPid),
    });
    if (!readyWritten) stopRequested.store(true, std::memory_order_release);

    std::unique_ptr<ActiveCapture> activeCapture;
    bool terminalFailure = !readyWritten;
    bool duplexStopPending = false;
    auto duplexStoppedAt = std::chrono::steady_clock::time_point{};
    while (!stopRequested.load(std::memory_order_acquire)) {
      if (getppid() != ownerPid) {
        stopRequested.store(true, std::memory_order_release);
        break;
      }
      const auto currentProcessObjects = audioProcessObjects(dynamicProcessTree(rootProcessIds));
      if (currentProcessObjects.empty()) {
        const bool hadActiveCapture = activeCapture != nullptr;
        OSStatus restoreStatus = noErr;
        if (hadActiveCapture) {
          restoreStatus = activeCapture->close();
          activeCapture.reset();
        }
        if (restoreStatus != noErr) {
          emitJSON(cpv::FrameType::Error, @{
            @"type" : @"error",
            @"code" : @"route_disengage_failed",
            @"message" : [NSString stringWithFormat:
                @"The original audio route could not be restored after its Core Audio process ended (OSStatus %d)",
                restoreStatus],
            @"suppressionHeld" : @YES,
          });
          return 1;
        }
        if (!anyProcessAlive(rootProcessIds)) {
          emitJSON(cpv::FrameType::Error, @{
            @"type" : @"error",
            @"code" : @"source_process_exited",
            @"message" : @"The selected application ended.",
            @"suppressionHeld" : @NO,
          });
          return 1;
        }
        if (hadActiveCapture && !emitJSON(cpv::FrameType::Status, @{
              @"type" : @"status",
              @"state" : @"armed",
              @"reason" : @"voice_audio_process_restarting",
              @"originalSuppressed" : @NO,
              @"tapActive" : @NO,
              @"captureVerified" : @NO,
            })) {
          terminalFailure = true;
          stopRequested.store(true, std::memory_order_release);
          break;
        }
        duplexStopPending = false;
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        continue;
      }
      if (activeCapture != nullptr &&
          !activeCapture->matchesProcessObjects(currentProcessObjects)) {
        const OSStatus restoreStatus = activeCapture->close();
        activeCapture.reset();
        if (restoreStatus != noErr) {
          emitJSON(cpv::FrameType::Error, @{
            @"type" : @"error",
            @"code" : @"route_disengage_failed",
            @"message" : [NSString stringWithFormat:
                @"Unable to restore the original audio route after its Core Audio process set changed (OSStatus %d)",
                restoreStatus],
            @"suppressionHeld" : @YES,
          });
          terminalFailure = true;
          stopRequested.store(true, std::memory_order_release);
          break;
        }
        if (!emitJSON(cpv::FrameType::Status, @{
              @"type" : @"status",
              @"state" : @"armed",
              @"reason" : @"voice_audio_process_membership_changed",
              @"originalSuppressed" : @NO,
              @"tapActive" : @NO,
              @"captureVerified" : @NO,
            })) {
          terminalFailure = true;
          stopRequested.store(true, std::memory_order_release);
          break;
        }
        duplexStopPending = false;
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        continue;
      }
      const bool inputRunning = anyProcessInputRunning(currentProcessObjects);
      const bool outputRunning = anyProcessOutputRunning(currentProcessObjects);
      const bool duplexRunning = inputRunning && outputRunning;
      if (activeCapture == nullptr) {
        if (duplexRunning) {
          auto candidate = std::make_unique<ActiveCapture>();
          NSString* failureMessage = nil;
          OSStatus failureStatus = noErr;
          if (!candidate->start(
                currentProcessObjects,
                declaredSampleRate,
                declaredChannels,
                &failureMessage,
                &failureStatus)) {
            emitJSON(cpv::FrameType::Error, @{
              @"type" : @"error",
              @"code" : @"route_engage_failed",
              @"message" : failureStatus == noErr
                  ? (failureMessage ?: @"Unable to engage the connected voice route")
                  : [NSString stringWithFormat:@"%@ (OSStatus %d)",
                        failureMessage ?: @"Unable to engage the connected voice route",
                        failureStatus],
              @"suppressionHeld" : @NO,
            });
            terminalFailure = true;
            stopRequested.store(true, std::memory_order_release);
            break;
          }
          if (!emitJSON(cpv::FrameType::Status, @{
                @"type" : @"status",
                @"state" : @"engaged",
                @"reason" : @"duplex_process_io_active",
                @"originalSuppressed" : @YES,
                @"tapActive" : @YES,
                @"captureVerified" : @YES,
              })) {
            candidate->close();
            terminalFailure = true;
            stopRequested.store(true, std::memory_order_release);
            break;
          }
          candidate->enableStreaming();
          activeCapture = std::move(candidate);
          duplexStopPending = false;
        }
      } else if (duplexRunning) {
        duplexStopPending = false;
      } else {
        const auto now = std::chrono::steady_clock::now();
        if (!duplexStopPending) {
          duplexStopPending = true;
          duplexStoppedAt = now;
        } else if (now - duplexStoppedAt >= kInputStopGrace) {
          const OSStatus restoreStatus = activeCapture->close();
          if (restoreStatus != noErr) {
            emitJSON(cpv::FrameType::Error, @{
              @"type" : @"error",
              @"code" : @"route_disengage_failed",
              @"message" : [NSString stringWithFormat:
                  @"Unable to restore the original audio route (OSStatus %d)", restoreStatus],
              @"suppressionHeld" : @YES,
            });
            terminalFailure = true;
            stopRequested.store(true, std::memory_order_release);
            activeCapture.reset();
            break;
          }
          if (!emitJSON(cpv::FrameType::Status, @{
                @"type" : @"status",
                @"state" : @"armed",
                @"reason" : @"voice_session_ended",
                @"originalSuppressed" : @NO,
                @"tapActive" : @NO,
                @"captureVerified" : @NO,
          })) {
            terminalFailure = true;
            stopRequested.store(true, std::memory_order_release);
            break;
          }
          activeCapture.reset();
          duplexStopPending = false;
        }
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }

    OSStatus shutdownRestoreStatus = noErr;
    if (activeCapture != nullptr) {
      shutdownRestoreStatus = activeCapture->close();
      if (shutdownRestoreStatus != noErr) {
        emitJSON(cpv::FrameType::Error, @{
          @"type" : @"error",
          @"code" : @"route_disengage_failed",
          @"message" : [NSString stringWithFormat:
              @"Unable to restore the original audio route during shutdown (OSStatus %d)",
              shutdownRestoreStatus],
          @"suppressionHeld" : @YES,
        });
      }
      activeCapture.reset();
    }
    return readyWritten && !terminalFailure && shutdownRestoreStatus == noErr ? 0 : 1;
  }
}
