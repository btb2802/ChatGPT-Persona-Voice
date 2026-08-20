#pragma once

#include <cstddef>
#include <cstdint>
#include <cstdio>

namespace cpv {

constexpr std::uint32_t kFrameMagic = 0x31565043;  // CPV1 in little-endian byte order.
constexpr std::uint16_t kProtocolVersion = 1;
constexpr std::uint32_t kMaximumPayloadBytes = 16 * 1024 * 1024;

enum class FrameType : std::uint16_t {
  Ready = 1,
  Audio = 2,
  Error = 3,
  Status = 4,
};

enum class SampleFormat : std::uint16_t {
  Float32LittleEndian = 1,
};

#pragma pack(push, 1)
struct FrameHeader {
  std::uint32_t magic;
  std::uint16_t version;
  std::uint16_t type;
  std::uint32_t payloadBytes;
};

struct AudioMetadata {
  std::uint32_t sequence;
  std::uint32_t sampleRate;
  std::uint16_t channels;
  std::uint16_t sampleFormat;
  std::uint32_t samplesPerChannel;
};
#pragma pack(pop)

static_assert(sizeof(FrameHeader) == 12);
static_assert(sizeof(AudioMetadata) == 16);

inline bool writeBytes(FILE* stream, const void* data, std::size_t size) {
  const auto* bytes = static_cast<const std::uint8_t*>(data);
  std::size_t written = 0;
  while (written < size) {
    const std::size_t count = fwrite(bytes + written, 1, size - written, stream);
    if (count == 0) return false;
    written += count;
  }
  return true;
}

inline bool readBytes(FILE* stream, void* data, std::size_t size) {
  auto* bytes = static_cast<std::uint8_t*>(data);
  std::size_t read = 0;
  while (read < size) {
    const std::size_t count = fread(bytes + read, 1, size - read, stream);
    if (count == 0) return false;
    read += count;
  }
  return true;
}

inline bool writeFrame(FILE* stream, FrameType type, const void* payload, std::uint32_t payloadBytes) {
  if (payloadBytes > kMaximumPayloadBytes) return false;
  const FrameHeader header{
      kFrameMagic,
      kProtocolVersion,
      static_cast<std::uint16_t>(type),
      payloadBytes,
  };
  if (!writeBytes(stream, &header, sizeof(header))) return false;
  if (payloadBytes > 0 && !writeBytes(stream, payload, payloadBytes)) return false;
  return fflush(stream) == 0;
}

inline bool validHeader(const FrameHeader& header) {
  return header.magic == kFrameMagic &&
         header.version == kProtocolVersion &&
         header.payloadBytes <= kMaximumPayloadBytes;
}

}  // namespace cpv
