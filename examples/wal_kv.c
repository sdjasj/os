#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

enum { MAGIC = 0x4b565741U, MAX_FIELD = 4096 };

typedef struct {
  uint32_t magic;
  uint32_t key_length;
  uint32_t value_length;
  uint32_t checksum;
} RecordHeader;

static uint32_t hash_bytes(uint32_t hash, const void *data, size_t length) {
  const unsigned char *bytes = data;
  for (size_t i = 0; i < length; i++) {
    hash = (hash ^ bytes[i]) * 16777619U;
  }
  return hash;
}

static uint32_t checksum(const char *key, size_t key_length, const char *value,
                         size_t value_length) {
  uint32_t hash = 2166136261U;
  hash = hash_bytes(hash, key, key_length);
  return hash_bytes(hash, value, value_length);
}

static int write_all(int fd, const void *data, size_t length) {
  const unsigned char *cursor = data;
  while (length > 0) {
    ssize_t count = write(fd, cursor, length);
    if (count < 0 && errno == EINTR) {
      continue;
    }
    if (count <= 0) {
      return -1;
    }
    cursor += count;
    length -= (size_t)count;
  }
  return 0;
}

static int read_exact(int fd, void *data, size_t length) {
  unsigned char *cursor = data;
  size_t received = 0;
  while (received < length) {
    ssize_t count = read(fd, cursor + received, length - received);
    if (count < 0 && errno == EINTR) {
      continue;
    }
    if (count <= 0) {
      return (int)received;
    }
    received += (size_t)count;
  }
  return (int)received;
}

static int append(const char *path, const char *key, const char *value) {
  size_t key_length = strlen(key);
  size_t value_length = strlen(value);
  if (key_length == 0 || key_length > MAX_FIELD || value_length > MAX_FIELD) {
    fputs("key/value has invalid length\n", stderr);
    return 1;
  }
  RecordHeader header = {
      .magic = MAGIC,
      .key_length = (uint32_t)key_length,
      .value_length = (uint32_t)value_length,
      .checksum = checksum(key, key_length, value, value_length),
  };
  int fd = open(path, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0644);
  if (fd < 0 || write_all(fd, &header, sizeof(header)) < 0 ||
      write_all(fd, key, key_length) < 0 ||
      write_all(fd, value, value_length) < 0 || fsync(fd) < 0 || close(fd) < 0) {
    perror("append/fsync WAL");
    return 1;
  }
  return 0;
}

static int dump(const char *path) {
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) {
    perror("open WAL");
    return 1;
  }
  unsigned index = 0;
  for (;;) {
    RecordHeader header;
    int count = read_exact(fd, &header, sizeof(header));
    if (count == 0) {
      break;
    }
    if (count != (int)sizeof(header) || header.magic != MAGIC ||
        header.key_length == 0 || header.key_length > MAX_FIELD ||
        header.value_length > MAX_FIELD) {
      fprintf(stderr, "ignore invalid/torn tail after record %u\n", index);
      break;
    }
    char key[MAX_FIELD + 1];
    char value[MAX_FIELD + 1];
    if (read_exact(fd, key, header.key_length) != (int)header.key_length ||
        read_exact(fd, value, header.value_length) !=
            (int)header.value_length) {
      fprintf(stderr, "ignore torn tail after record %u\n", index);
      break;
    }
    key[header.key_length] = '\0';
    value[header.value_length] = '\0';
    if (checksum(key, header.key_length, value, header.value_length) !=
        header.checksum) {
      fprintf(stderr, "checksum mismatch at record %u\n", index);
      break;
    }
    printf("%u: SET %s = %s\n", index++, key, value);
  }
  close(fd);
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 5 && strcmp(argv[1], "set") == 0) {
    return append(argv[2], argv[3], argv[4]);
  }
  if (argc == 3 && strcmp(argv[1], "dump") == 0) {
    return dump(argv[2]);
  }
  fprintf(stderr, "usage: %s set LOG KEY VALUE | dump LOG\n", argv[0]);
  return 1;
}
