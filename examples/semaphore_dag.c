#include <pthread.h>
#include <semaphore.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

static sem_t parsed_for_compress;
static sem_t parsed_for_encrypt;
static sem_t compressed;
static sem_t encrypted;

static void *parse(void *unused) {
  (void)unused;
  puts("1. parse request");
  sem_post(&parsed_for_compress);
  sem_post(&parsed_for_encrypt);
  return NULL;
}

static void *compress(void *unused) {
  (void)unused;
  sem_wait(&parsed_for_compress);
  puts("2a. compress body");
  sem_post(&compressed);
  return NULL;
}

static void *encrypt(void *unused) {
  (void)unused;
  sem_wait(&parsed_for_encrypt);
  puts("2b. encrypt metadata");
  sem_post(&encrypted);
  return NULL;
}

static void *package(void *unused) {
  (void)unused;
  sem_wait(&compressed);
  sem_wait(&encrypted);
  puts("3. package response (both prerequisites satisfied)");
  return NULL;
}

int main(void) {
  sem_t *all[] = {&parsed_for_compress, &parsed_for_encrypt, &compressed,
                  &encrypted};
  for (size_t i = 0; i < sizeof(all) / sizeof(all[0]); i++) {
    if (sem_init(all[i], 0, 0) < 0) {
      perror("sem_init");
      return EXIT_FAILURE;
    }
  }

  pthread_t threads[4];
  void *(*steps[])(void *) = {package, compress, encrypt, parse};
  for (int i = 0; i < 4; i++) {
    pthread_create(&threads[i], NULL, steps[i], NULL);
  }
  for (int i = 0; i < 4; i++) {
    pthread_join(threads[i], NULL);
  }
  for (size_t i = 0; i < sizeof(all) / sizeof(all[0]); i++) {
    sem_destroy(all[i]);
  }
  return 0;
}
