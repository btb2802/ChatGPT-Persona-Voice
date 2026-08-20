#include "PipeWireCommon.hpp"

#include <pipewire/pipewire.h>

#include <spa/param/audio/format-utils.h>
#include <spa/utils/ringbuffer.h>
#include <spa/utils/result.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <csignal>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include <poll.h>
#include <unistd.h>

namespace {

constexpr std::uint32_t kMaximumFrameDurationMs = 40;
constexpr std::uint32_t kStartupPrebufferMs = 500;
constexpr std::uint32_t kQueueCapacityFrames = 64;

std::atomic<bool> stopRequested{false};

void handleSignal(int) {
  stopRequested.store(true, std::memory_order_release);
}

class SampleRing {
 public:
  explicit SampleRing(std::size_t capacitySamples)
      : samples_(capacitySamples), capacity_(capacitySamples) {}

  std::size_t available() const {
    const std::uint64_t written = written_.load(std::memory_order_acquire);
    const std::uint64_t read = read_.load(std::memory_order_acquire);
    return static_cast<std::size_t>(written - read);
  }

  std::size_t freeSpace() const { return capacity_ - available(); }

  bool write(const float* input, std::size_t count) {
    if (input == nullptr || count == 0 || count > freeSpace()) return false;
    const std::uint64_t written = written_.load(std::memory_order_relaxed);
    const std::size_t offset = static_cast<std::size_t>(written % capacity_);
    const std::size_t first = std::min(count, capacity_ - offset);
    std::copy_n(input, first, samples_.begin() + static_cast<std::ptrdiff_t>(offset));
    if (first < count) std::copy_n(input + first, count - first, samples_.begin());
    written_.store(written + count, std::memory_order_release);
    return true;
  }

  std::size_t read(float* output, std::size_t count) {
    if (output == nullptr || count == 0) return 0;
    const std::uint64_t read = read_.load(std::memory_order_relaxed);
    const std::size_t amount = std::min(count, available());
    const std::size_t offset = static_cast<std::size_t>(read % capacity_);
    const std::size_t first = std::min(amount, capacity_ - offset);
    std::copy_n(samples_.begin() + static_cast<std::ptrdiff_t>(offset), first, output);
    if (first < amount) std::copy_n(samples_.begin(), amount - first, output + first);
    read_.store(read + amount, std::memory_order_release);
    return amount;
  }

 private:
  std::vector<float> samples_;
  const std::size_t capacity_;
  std::atomic<std::uint64_t> written_{0};
  std::atomic<std::uint64_t> read_{0};
};

class PipeWireOutput {
 public:
  PipeWireOutput(
      std::uint32_t sampleRate,
      std::uint16_t channels,
      std::string targetObject)
      : sampleRate_(sampleRate),
        channels_(channels),
        targetObject_(std::move(targetObject)),
        maximumSamplesPerFrame_((static_cast<std::uint64_t>(sampleRate_) *
            kMaximumFrameDurationMs + 999) / 1000),
        prebufferSamplesPerChannel_((static_cast<std::uint64_t>(sampleRate_) *
            kStartupPrebufferMs + 999) / 1000),
        ring_(static_cast<std::size_t>(maximumSamplesPerFrame_) * channels_ * kQueueCapacityFrames) {}

  ~PipeWireOutput() { shutdown(); }

  bool connect(std::string* error) {
    pw_init(nullptr, nullptr);
    loop_ = pw_thread_loop_new("cpv-pipewire-output", nullptr);
    if (loop_ == nullptr) return fail(error, "Unable to create the PipeWire output loop");
    if (pw_thread_loop_start(loop_) < 0) {
      return fail(error, cpv::linux_audio::errnoMessage("Unable to start the PipeWire output loop"));
    }
    loopStarted_ = true;
    pw_thread_loop_lock(loop_);
    pw_properties* properties = pw_properties_new(
        PW_KEY_MEDIA_TYPE, "Audio",
        PW_KEY_MEDIA_CATEGORY, "Playback",
        PW_KEY_MEDIA_ROLE, "Communication",
        PW_KEY_NODE_NAME, "codex-persona-voice.converted-output",
        PW_KEY_NODE_DESCRIPTION, "Codex Persona Voice converted output",
        PW_KEY_NODE_DONT_RECONNECT, "true",
        nullptr);
    if (!targetObject_.empty()) pw_properties_set(properties, PW_KEY_TARGET_OBJECT, targetObject_.c_str());
    stream_ = pw_stream_new_simple(
        pw_thread_loop_get_loop(loop_),
        "cpv-converted-output",
        properties,
        &streamEvents_,
        this);
    if (stream_ == nullptr) {
      pw_thread_loop_unlock(loop_);
      return fail(error, cpv::linux_audio::errnoMessage("Unable to create the PipeWire output stream"));
    }
    std::array<std::uint8_t, 1'024> buffer{};
    spa_pod_builder builder = SPA_POD_BUILDER_INIT(buffer.data(), buffer.size());
    spa_audio_info_raw format = SPA_AUDIO_INFO_RAW_INIT(
        .format = SPA_AUDIO_FORMAT_F32,
        .rate = sampleRate_,
        .channels = channels_);
    const spa_pod* params[] = {
        spa_format_audio_raw_build(&builder, SPA_PARAM_EnumFormat, &format),
    };
    const int result = pw_stream_connect(
        stream_,
        PW_DIRECTION_OUTPUT,
        PW_ID_ANY,
        static_cast<pw_stream_flags>(
            PW_STREAM_FLAG_AUTOCONNECT |
            PW_STREAM_FLAG_MAP_BUFFERS |
            PW_STREAM_FLAG_RT_PROCESS),
        params,
        1);
    if (result < 0) {
      pw_thread_loop_unlock(loop_);
      return fail(error, std::string("Unable to connect the PipeWire output stream: ") + spa_strerror(result));
    }
    while (state_ != PW_STREAM_STATE_PAUSED && state_ != PW_STREAM_STATE_STREAMING &&
           state_ != PW_STREAM_STATE_ERROR) {
      pw_thread_loop_wait(loop_);
    }
    if (state_ == PW_STREAM_STATE_ERROR) {
      const std::string detail = stateError_.empty() ? "PipeWire output entered an error state" : stateError_;
      pw_thread_loop_unlock(loop_);
      return fail(error, detail);
    }
    pw_thread_loop_unlock(loop_);
    return true;
  }

  bool emitReady(bool selfTest = false) const {
    std::ostringstream json;
    json << "{\"type\":\"ready\",\"helper\":\"output\",\"protocolVersion\":1"
         << ",\"sampleRate\":" << (selfTest ? 48'000 : sampleRate_)
         << ",\"channels\":" << (selfTest ? 2 : channels_)
         << ",\"sampleFormat\":\"f32le\""
         << ",\"maximumFrameDurationMs\":" << kMaximumFrameDurationMs
         << ",\"queueCapacityFrames\":" << kQueueCapacityFrames
         << ",\"supportsJitterBuffer\":true,\"startsWhenQueueFull\":true"
         << ",\"startupPrebufferMs\":" << kStartupPrebufferMs
         << ",\"supportsNativePipeWire\":true"
         << ",\"targetObject\":\"" << cpv::linux_audio::jsonEscape(
                targetObject_.empty() ? "@DEFAULT_AUDIO_SINK@" : targetObject_) << '"'
         << ",\"usesDefaultDevice\":" << (targetObject_.empty() ? "true" : "false") << '}';
    return cpv::linux_audio::writeJson(cpv::FrameType::Ready, json.str());
  }

  bool enqueue(const cpv::AudioMetadata& metadata, const float* pcm, std::string* error) {
    if (metadata.sampleRate != sampleRate_ || metadata.channels != channels_ ||
        metadata.sampleFormat != static_cast<std::uint16_t>(cpv::SampleFormat::Float32LittleEndian) ||
        metadata.samplesPerChannel == 0 || metadata.samplesPerChannel > maximumSamplesPerFrame_) {
      return fail(error, "Output frame format or duration does not match the prepared PipeWire sink");
    }
    const std::size_t sampleCount = static_cast<std::size_t>(metadata.samplesPerChannel) * channels_;
    std::unique_lock lock(waitMutex_);
    if (!spaceAvailable_.wait_for(lock, std::chrono::seconds(5), [&] {
          return ring_.freeSpace() >= sampleCount || outputFault_.load(std::memory_order_acquire) ||
              stopRequested.load(std::memory_order_acquire);
        })) {
      return fail(error, "The bounded PipeWire output queue did not accept a frame within 5 seconds");
    }
    if (outputFault_.load(std::memory_order_acquire) || stopRequested.load(std::memory_order_acquire)) {
      return fail(error, "PipeWire output closed before accepting the converted frame");
    }
    if (!ring_.write(pcm, sampleCount)) return fail(error, "PipeWire output queue capacity changed unexpectedly");
    return true;
  }

  void markInputEnded() {
    inputEnded_.store(true, std::memory_order_release);
  }

  bool waitForDrain(std::string* error) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (ring_.available() > 0 && std::chrono::steady_clock::now() < deadline &&
           !outputFault_.load(std::memory_order_acquire)) {
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    if (ring_.available() > 0) return fail(error, "Converted PipeWire output did not drain within 5 seconds");
    return !outputFault_.load(std::memory_order_acquire) ||
        fail(error, stateError_.empty() ? "PipeWire output failed" : stateError_);
  }

 private:
  bool fail(std::string* error, std::string message) const {
    if (error != nullptr) *error = std::move(message);
    return false;
  }

  static void onStateChanged(
      void* data,
      pw_stream_state,
      pw_stream_state state,
      const char* error) {
    auto* self = static_cast<PipeWireOutput*>(data);
    self->state_ = state;
    self->stateError_ = error == nullptr ? std::string{} : std::string(error);
    if (state == PW_STREAM_STATE_ERROR) self->outputFault_.store(true, std::memory_order_release);
    pw_thread_loop_signal(self->loop_, false);
    self->spaceAvailable_.notify_all();
  }

  static void onProcess(void* data) {
    static_cast<PipeWireOutput*>(data)->process();
  }

  void emitBufferState(const char* state, const char* reason, std::uint32_t underruns) {
    std::ostringstream json;
    json << "{\"type\":\"status\",\"helper\":\"output\",\"state\":\"" << state
         << "\",\"reason\":\"" << reason << "\",\"underruns\":" << underruns;
    if (std::strcmp(state, "running") == 0) {
      json << ",\"bufferedMs\":" << (ring_.available() / channels_) * 1000 / sampleRate_;
    } else {
      json << ",\"targetBufferedMs\":" << kStartupPrebufferMs;
    }
    json << '}';
    cpv::linux_audio::writeJson(cpv::FrameType::Status, json.str());
  }

  void requestStatus(bool running, bool recovered) {
    const std::uint32_t value = running
        ? (recovered ? 2U : 1U)
        : 3U;
    pendingStatus_.store(value, std::memory_order_release);
  }

  void process() {
    pw_buffer* pipewireBuffer = pw_stream_dequeue_buffer(stream_);
    if (pipewireBuffer == nullptr) return;
    spa_buffer* buffer = pipewireBuffer->buffer;
    if (buffer == nullptr || buffer->n_datas == 0 || buffer->datas[0].data == nullptr ||
        buffer->datas[0].chunk == nullptr) {
      pw_stream_queue_buffer(stream_, pipewireBuffer);
      return;
    }
    spa_data& data = buffer->datas[0];
    auto* output = static_cast<float*>(data.data);
    const std::size_t maximumFrames = data.maxsize / (channels_ * sizeof(float));
    const std::size_t requestedFrames = pipewireBuffer->requested == 0
        ? maximumFrames
        : std::min<std::size_t>(pipewireBuffer->requested, maximumFrames);
    const std::size_t prebufferSamples = static_cast<std::size_t>(prebufferSamplesPerChannel_) * channels_;
    const std::size_t available = ring_.available();
    bool running = running_.load(std::memory_order_relaxed);
    if (!running && (available >= prebufferSamples || (inputEnded_.load(std::memory_order_acquire) && available > 0))) {
      const bool recovered = everStarted_.exchange(true, std::memory_order_acq_rel);
      running = true;
      running_.store(true, std::memory_order_release);
      requestStatus(true, recovered);
    }

    const std::size_t requestedSamples = requestedFrames * channels_;
    std::size_t copied = 0;
    if (running) copied = ring_.read(output, requestedSamples);
    if (copied < requestedSamples) {
      std::fill(output + copied, output + requestedSamples, 0.0f);
      if (running && !inputEnded_.load(std::memory_order_acquire)) {
        running_.store(false, std::memory_order_release);
        underruns_.fetch_add(1, std::memory_order_acq_rel);
        requestStatus(false, false);
      }
    }
    data.chunk->offset = 0;
    data.chunk->stride = channels_ * sizeof(float);
    data.chunk->size = requestedSamples * sizeof(float);
    pw_stream_queue_buffer(stream_, pipewireBuffer);
    if (copied > 0) spaceAvailable_.notify_all();
  }

  void statusLoop() {
    while (!statusStop_.load(std::memory_order_acquire)) {
      const std::uint32_t status = pendingStatus_.exchange(0, std::memory_order_acq_rel);
      if (status == 1) emitBufferState("running", "jitter_buffer_primed", underruns_.load());
      else if (status == 2) emitBufferState("running", "jitter_buffer_recovered", underruns_.load());
      else if (status == 3) emitBufferState("rebuffering", "output_underrun", underruns_.load());
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
  }

  void shutdown() {
    statusStop_.store(true, std::memory_order_release);
    if (statusThread_.joinable()) statusThread_.join();
    if (loop_ != nullptr && loopStarted_) pw_thread_loop_lock(loop_);
    if (stream_ != nullptr) {
      pw_stream_destroy(stream_);
      stream_ = nullptr;
    }
    if (loop_ != nullptr && loopStarted_) {
      pw_thread_loop_unlock(loop_);
      pw_thread_loop_stop(loop_);
      loopStarted_ = false;
    }
    if (loop_ != nullptr) {
      pw_thread_loop_destroy(loop_);
      loop_ = nullptr;
    }
    pw_deinit();
  }

 public:
  void startStatusThread() { statusThread_ = std::thread([this] { statusLoop(); }); }

 private:
  inline static const pw_stream_events streamEvents_ = {
      .version = PW_VERSION_STREAM_EVENTS,
      .state_changed = onStateChanged,
      .process = onProcess,
  };

  const std::uint32_t sampleRate_;
  const std::uint16_t channels_;
  const std::string targetObject_;
  const std::uint32_t maximumSamplesPerFrame_;
  const std::uint32_t prebufferSamplesPerChannel_;
  SampleRing ring_;
  pw_thread_loop* loop_ = nullptr;
  pw_stream* stream_ = nullptr;
  bool loopStarted_ = false;
  pw_stream_state state_ = PW_STREAM_STATE_UNCONNECTED;
  std::string stateError_;
  std::mutex waitMutex_;
  std::condition_variable spaceAvailable_;
  std::atomic<bool> running_{false};
  std::atomic<bool> everStarted_{false};
  std::atomic<bool> inputEnded_{false};
  std::atomic<bool> outputFault_{false};
  std::atomic<std::uint32_t> underruns_{0};
  std::atomic<std::uint32_t> pendingStatus_{0};
  std::atomic<bool> statusStop_{false};
  std::thread statusThread_;
};

bool parseArguments(
    int argc,
    char** argv,
    bool* selfTest,
    std::uint32_t* sampleRate,
    std::uint16_t* channels,
    std::string* targetObject) {
  for (int index = 1; index < argc; ++index) {
    if (std::strcmp(argv[index], "--self-test") == 0) {
      *selfTest = true;
    } else if (std::strcmp(argv[index], "--sample-rate") == 0 && index + 1 < argc) {
      const auto parsed = cpv::linux_audio::parseU32(argv[++index], 8'000, 192'000);
      if (!parsed) return false;
      *sampleRate = *parsed;
    } else if (std::strcmp(argv[index], "--channels") == 0 && index + 1 < argc) {
      const auto parsed = cpv::linux_audio::parseU32(argv[++index], 1, 2);
      if (!parsed) return false;
      *channels = static_cast<std::uint16_t>(*parsed);
    } else if (std::strcmp(argv[index], "--target-object") == 0 && index + 1 < argc) {
      *targetObject = argv[++index];
      if (targetObject->empty() || targetObject->size() > 4'096) return false;
    } else {
      return false;
    }
  }
  return true;
}

}  // namespace

int main(int argc, char** argv) {
  signal(SIGPIPE, SIG_IGN);
  signal(SIGINT, handleSignal);
  signal(SIGTERM, handleSignal);
  setvbuf(stdin, nullptr, _IONBF, 0);
  setvbuf(stdout, nullptr, _IONBF, 0);

  bool selfTest = false;
  std::uint32_t sampleRate = 0;
  std::uint16_t channels = 0;
  std::string targetObject;
  if (!parseArguments(argc, argv, &selfTest, &sampleRate, &channels, &targetObject)) {
    cpv::linux_audio::writeError("invalid_arguments", "Invalid PipeWire output arguments");
    return 2;
  }
  if (selfTest) {
    sampleRate = 48'000;
    channels = 2;
  } else if (sampleRate == 0 || channels == 0) {
    cpv::linux_audio::writeError("invalid_arguments", "--sample-rate and --channels are required");
    return 2;
  }

  PipeWireOutput output(sampleRate, channels, targetObject);
  std::string error;
  if (!output.connect(&error)) {
    cpv::linux_audio::writeError("output_initialization_failed", error);
    return 1;
  }
  if (!output.emitReady(selfTest)) return 1;
  if (selfTest) return 0;
  output.startStatusThread();

  bool failed = false;
  std::optional<std::uint32_t> expectedSequence;
  while (!stopRequested.load(std::memory_order_acquire)) {
    pollfd descriptor{STDIN_FILENO, static_cast<short>(POLLIN | POLLHUP), 0};
    const int pollResult = poll(&descriptor, 1, 50);
    if (pollResult < 0) {
      if (errno == EINTR) continue;
      error = cpv::linux_audio::errnoMessage("Unable to wait for converted PCM input");
      failed = true;
      break;
    }
    if (pollResult == 0) continue;
    cpv::FrameHeader header{};
    const std::size_t headerBytes = fread(&header, 1, sizeof(header), stdin);
    if (headerBytes == 0 && feof(stdin)) break;
    if (headerBytes != sizeof(header) || !cpv::validHeader(header) ||
        header.type != static_cast<std::uint16_t>(cpv::FrameType::Audio) ||
        header.payloadBytes < sizeof(cpv::AudioMetadata)) {
      error = "Output received an invalid CPV1 audio frame";
      failed = true;
      break;
    }
    std::vector<std::uint8_t> payload(header.payloadBytes);
    if (!cpv::readBytes(stdin, payload.data(), payload.size())) {
      error = "Output received a truncated CPV1 audio frame";
      failed = true;
      break;
    }
    cpv::AudioMetadata metadata{};
    std::memcpy(&metadata, payload.data(), sizeof(metadata));
    const std::uint64_t pcmBytes = static_cast<std::uint64_t>(metadata.samplesPerChannel) *
        metadata.channels * sizeof(float);
    if (pcmBytes + sizeof(metadata) != payload.size()) {
      error = "Output PCM length does not match CPV1 metadata";
      failed = true;
      break;
    }
    if (expectedSequence.has_value() && metadata.sequence != *expectedSequence) {
      error = "Converted output sequence is not contiguous";
      failed = true;
      break;
    }
    expectedSequence = metadata.sequence + 1;
    if (!output.enqueue(
            metadata,
            reinterpret_cast<const float*>(payload.data() + sizeof(metadata)),
            &error)) {
      failed = true;
      break;
    }
  }
  output.markInputEnded();
  if (!failed && !output.waitForDrain(&error)) failed = true;
  if (failed) cpv::linux_audio::writeError("output_failed", error);
  return failed ? 1 : 0;
}
