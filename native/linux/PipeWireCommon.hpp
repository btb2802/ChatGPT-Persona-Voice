#pragma once

#include "../shared/NativeProtocol.hpp"

#include <algorithm>
#include <cerrno>
#include <charconv>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>

namespace cpv::linux_audio {

inline std::mutex stdout_mutex;

inline std::string jsonEscape(std::string_view value) {
  std::string output;
  output.reserve(value.size() + 16);
  constexpr char hex[] = "0123456789abcdef";
  for (const unsigned char byte : value) {
    switch (byte) {
      case '"': output += "\\\""; break;
      case '\\': output += "\\\\"; break;
      case '\b': output += "\\b"; break;
      case '\f': output += "\\f"; break;
      case '\n': output += "\\n"; break;
      case '\r': output += "\\r"; break;
      case '\t': output += "\\t"; break;
      default:
        if (byte < 0x20) {
          output += "\\u00";
          output.push_back(hex[(byte >> 4) & 0x0f]);
          output.push_back(hex[byte & 0x0f]);
        } else {
          output.push_back(static_cast<char>(byte));
        }
    }
  }
  return output;
}

inline bool writeJson(cpv::FrameType type, const std::string& json) {
  if (json.size() > cpv::kMaximumPayloadBytes) return false;
  const std::lock_guard<std::mutex> lock(stdout_mutex);
  return cpv::writeFrame(
      stdout,
      type,
      json.data(),
      static_cast<std::uint32_t>(json.size()));
}

inline bool writeAudio(
    std::uint32_t sequence,
    std::uint32_t sampleRate,
    std::uint16_t channels,
    std::uint32_t samplesPerChannel,
    const float* pcm) {
  if (pcm == nullptr || samplesPerChannel == 0 || channels == 0 || channels > 2) return false;
  const std::uint64_t pcmBytes = static_cast<std::uint64_t>(samplesPerChannel) *
      channels * sizeof(float);
  if (pcmBytes + sizeof(cpv::AudioMetadata) > cpv::kMaximumPayloadBytes) return false;
  const cpv::AudioMetadata metadata{
      sequence,
      sampleRate,
      channels,
      static_cast<std::uint16_t>(cpv::SampleFormat::Float32LittleEndian),
      samplesPerChannel,
  };
  const cpv::FrameHeader header{
      cpv::kFrameMagic,
      cpv::kProtocolVersion,
      static_cast<std::uint16_t>(cpv::FrameType::Audio),
      static_cast<std::uint32_t>(sizeof(metadata) + pcmBytes),
  };
  const std::lock_guard<std::mutex> lock(stdout_mutex);
  return cpv::writeBytes(stdout, &header, sizeof(header)) &&
      cpv::writeBytes(stdout, &metadata, sizeof(metadata)) &&
      cpv::writeBytes(stdout, pcm, static_cast<std::size_t>(pcmBytes)) &&
      fflush(stdout) == 0;
}

inline bool writeError(
    std::string_view code,
    std::string_view message,
    std::optional<bool> suppressionHeld = std::nullopt) {
  std::ostringstream json;
  json << "{\"type\":\"error\",\"code\":\"" << jsonEscape(code)
       << "\",\"message\":\"" << jsonEscape(message) << '"';
  if (suppressionHeld.has_value()) {
    json << ",\"suppressionHeld\":" << (*suppressionHeld ? "true" : "false");
  }
  json << '}';
  return writeJson(cpv::FrameType::Error, json.str());
}

inline std::optional<std::uint32_t> parseU32(
    const char* value,
    std::uint32_t minimum = 0,
    std::uint32_t maximum = UINT32_MAX) {
  if (value == nullptr || *value == '\0') return std::nullopt;
  std::uint32_t parsed = 0;
  const char* end = value + std::strlen(value);
  const auto result = std::from_chars(value, end, parsed);
  if (result.ec != std::errc{} || result.ptr != end || parsed < minimum || parsed > maximum) {
    return std::nullopt;
  }
  return parsed;
}

inline std::string errnoMessage(std::string_view prefix) {
  return std::string(prefix) + ": " + std::strerror(errno);
}

}  // namespace cpv::linux_audio
