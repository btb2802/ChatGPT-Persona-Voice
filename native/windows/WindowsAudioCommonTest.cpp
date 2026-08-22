#include "WindowsAudioCommon.hpp"

#include <iostream>
#include <string_view>

namespace {

int expect(bool condition, std::string_view message) {
  if (condition) return 0;
  std::cerr << message << '\n';
  return 1;
}

cpv::windows::VbCableDeviceIdentity pack45Identity() {
  return {
      .description = L"CABLE Input",
      .matchingDeviceId = L"VBAudioVACWDM",
  };
}

}  // namespace

int main() {
  int failures = 0;
  failures += expect(
      cpv::windows::matchesVbCableInputIdentity(pack45Identity()),
      "Pack45 must be identified without endpoint friendly-name properties");

  auto sixteenChannel = pack45Identity();
  sixteenChannel.description = L"CABLE In 16ch";
  failures += expect(
      !cpv::windows::matchesVbCableInputIdentity(sixteenChannel),
      "The 16-channel endpoint must not be accepted as the base CABLE Input");

  auto lookalike = pack45Identity();
  lookalike.matchingDeviceId = L"UNRELATED_AUDIO_DEVICE";
  failures += expect(
      !cpv::windows::matchesVbCableInputIdentity(lookalike),
      "A lookalike endpoint with another driver identity must be rejected");

  auto missingIdentity = pack45Identity();
  missingIdentity.matchingDeviceId.clear();
  failures += expect(
      !cpv::windows::matchesVbCableInputIdentity(missingIdentity),
      "An endpoint without driver identity proof must fail closed");

  auto caseVariant = pack45Identity();
  caseVariant.matchingDeviceId = L"vbaudiovacwdm";
  failures += expect(
      cpv::windows::matchesVbCableInputIdentity(caseVariant),
      "PnP identifiers must be compared case-insensitively");

  return failures == 0 ? 0 : 1;
}
