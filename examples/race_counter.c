#include <pthread.h>
#include <sched.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum { THREADS = 4, INCREMENTS = 200000 };

static volatile uint64_t racy_counter;
static _Atomic uint64_t atomic_counter;
static uint64_t locked_counter;
static pthread_mutex_t counter_lock = PTHREAD_MUTEX_INITIALIZER;

static void *run_racy(void *unused) {
  (void)unused;
  for (int i = 0; i < INCREMENTS; i++) {
    uint64_t snapshot = racy_counter;
    if ((i & 1023) == 0) {
      sched_yield();
    }
    racy_counter = snapshot + 1;  // load-add-store 不是一个不可分割的动作。
  }
  return NULL;
}

static void *run_atomic(void *unused) {
  (void)unused;
  for (int i = 0; i < INCREMENTS; i++) {
    atomic_fetch_add_explicit(&atomic_counter, 1, memory_order_relaxed);
  }
  return NULL;
}

static void *run_locked(void *unused) {
  (void)unused;
  for (int i = 0; i < INCREMENTS; i++) {
    pthread_mutex_lock(&counter_lock);
    locked_counter++;
    pthread_mutex_unlock(&counter_lock);
  }
  return NULL;
}

int main(int argc, char **argv) {
  const char *mode = argc == 2 ? argv[1] : "race";
  void *(*worker)(void *) = run_racy;
  if (strcmp(mode, "atomic") == 0) {
    worker = run_atomic;
  } else if (strcmp(mode, "mutex") == 0) {
    worker = run_locked;
  } else if (strcmp(mode, "race") != 0) {
    fprintf(stderr, "usage: %s [race|atomic|mutex]\n", argv[0]);
    return EXIT_FAILURE;
  }

  pthread_t threads[THREADS];
  for (int i = 0; i < THREADS; i++) {
    if (pthread_create(&threads[i], NULL, worker, NULL) != 0) {
      fputs("pthread_create failed\n", stderr);
      return EXIT_FAILURE;
    }
  }
  for (int i = 0; i < THREADS; i++) {
    pthread_join(threads[i], NULL);
  }

  uint64_t result = racy_counter;
  if (strcmp(mode, "atomic") == 0) {
    result = atomic_load_explicit(&atomic_counter, memory_order_relaxed);
  } else if (strcmp(mode, "mutex") == 0) {
    result = locked_counter;
  }
  printf("mode=%s expected=%d actual=%llu\n", mode, THREADS * INCREMENTS,
         (unsigned long long)result);
  return 0;
}
