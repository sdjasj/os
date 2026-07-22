#include <pthread.h>
#include <stdalign.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

typedef struct {
  const uint32_t *values;
  size_t begin;
  size_t end;
  alignas(64) uint64_t sum;  // 每个结果独占缓存行，避免 false sharing。
} Job;

static void *sum_range(void *argument) {
  Job *job = argument;
  uint64_t local = 0;
  for (size_t i = job->begin; i < job->end; i++) {
    local += job->values[i];
  }
  job->sum = local;  // 每个线程只写一次共享内存。
  return NULL;
}

int main(int argc, char **argv) {
  int thread_count = argc > 1 ? atoi(argv[1]) : 4;
  size_t length = argc > 2 ? strtoull(argv[2], NULL, 10) : 1000000;
  if (thread_count <= 0 || thread_count > 128 || length == 0) {
    fprintf(stderr, "usage: %s THREADS POSITIVE_LENGTH\n", argv[0]);
    return EXIT_FAILURE;
  }

  uint32_t *values = malloc(length * sizeof(*values));
  pthread_t *threads = calloc((size_t)thread_count, sizeof(*threads));
  Job *jobs = aligned_alloc(64, (size_t)thread_count * sizeof(*jobs));
  if (values == NULL || threads == NULL || jobs == NULL) {
    fputs("allocation failed\n", stderr);
    return EXIT_FAILURE;
  }
  for (size_t i = 0; i < length; i++) {
    values[i] = (uint32_t)(i % 10);
  }

  for (int i = 0; i < thread_count; i++) {
    size_t begin = length * (size_t)i / (size_t)thread_count;
    size_t end = length * (size_t)(i + 1) / (size_t)thread_count;
    jobs[i] = (Job){.values = values, .begin = begin, .end = end, .sum = 0};
    pthread_create(&threads[i], NULL, sum_range, &jobs[i]);
  }

  uint64_t total = 0;
  for (int i = 0; i < thread_count; i++) {
    pthread_join(threads[i], NULL);
    total += jobs[i].sum;
  }
  printf("threads=%d length=%zu sum=%llu\n", thread_count, length,
         (unsigned long long)total);
  free(jobs);
  free(threads);
  free(values);
  return 0;
}
