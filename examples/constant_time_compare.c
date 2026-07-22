#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int insecure_equal(const unsigned char *left, const unsigned char *right,
                          size_t length, size_t *operations) {
  *operations = 0;
  for (size_t i = 0; i < length; i++) {
    (*operations)++;
    if (left[i] != right[i]) {
      return 0;  // 不同前缀会产生不同运行时间，泄漏信息。
    }
  }
  return 1;
}

static int constant_time_equal(const unsigned char *left,
                               const unsigned char *right, size_t length,
                               size_t *operations) {
  unsigned difference = 0;
  *operations = 0;
  for (size_t i = 0; i < length; i++) {
    difference |= left[i] ^ right[i];
    (*operations)++;
  }
  return difference == 0;
}

int main(int argc, char **argv) {
  if (argc != 3 || strlen(argv[1]) != strlen(argv[2])) {
    fprintf(stderr, "usage: %s EQUAL_LENGTH_A EQUAL_LENGTH_B\n", argv[0]);
    return EXIT_FAILURE;
  }
  size_t length = strlen(argv[1]);
  size_t insecure_operations;
  size_t constant_operations;
  int insecure = insecure_equal((unsigned char *)argv[1],
                                (unsigned char *)argv[2], length,
                                &insecure_operations);
  int constant = constant_time_equal((unsigned char *)argv[1],
                                     (unsigned char *)argv[2], length,
                                     &constant_operations);
  printf("insecure: equal=%d compared=%zu; constant-time: equal=%d compared=%zu\n",
         insecure, insecure_operations, constant, constant_operations);
  return 0;
}
