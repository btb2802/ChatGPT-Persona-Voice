#include "WindowsAudioCommon.hpp"

int wmain() {
  using cpv::windows::matchesVbCableInputProperties;

  if (!matchesVbCableInputProperties(L"CABLE Input", L"VB-Audio Point", L"")) return 1;
  if (!matchesVbCableInputProperties(
          L"CABLE Input", L"", L"CABLE Input (VB-Audio Virtual Cable)")) return 2;
  if (matchesVbCableInputProperties(L"CABLE Input", L"", L"Speakers")) return 3;
  if (matchesVbCableInputProperties(
          L"Speakers", L"VB-Audio Point", L"CABLE Input (VB-Audio Virtual Cable)")) return 4;
  if (matchesVbCableInputProperties(
          L"CABLE Input", L"Different Adapter", L"CABLE Input (VB-Audio Virtual Cable)")) return 5;
  return 0;
}
