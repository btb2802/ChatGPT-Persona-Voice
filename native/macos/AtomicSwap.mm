#import <Foundation/Foundation.h>

#include <cerrno>
#include <cstdio>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/stdio.h>

namespace {

bool isExistingDirectory(const char* value) {
  struct stat attributes {};
  return value != nullptr && value[0] == '/' && lstat(value, &attributes) == 0 &&
      S_ISDIR(attributes.st_mode);
}

}  // namespace

int main(int argc, const char* argv[]) {
  @autoreleasepool {
    if (argc != 3 || !isExistingDirectory(argv[1]) || !isExistingDirectory(argv[2])) {
      std::fprintf(stderr, "cpv-atomic-swap requires two existing absolute directories\n");
      return 2;
    }
    if (renameatx_np(AT_FDCWD, argv[1], AT_FDCWD, argv[2], RENAME_SWAP) != 0) {
      std::fprintf(stderr, "atomic directory swap failed: errno %d\n", errno);
      return 1;
    }
    return 0;
  }
}
