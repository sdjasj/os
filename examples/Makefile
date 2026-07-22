CC ?= cc
CFLAGS ?= -std=c11 -O2 -g -Wall -Wextra -Wpedantic -D_GNU_SOURCE
PTHREAD = -pthread

PROGRAMS = \
	state_machine \
	fork_exec \
	mmap_cow \
	pipeline \
	mini_malloc \
	clock_user \
	race_counter \
	mutex_transfer \
	bounded_buffer \
	semaphore_dag \
	parallel_sum \
	epoll_timer \
	device_file \
	atomic_replace \
	wal_kv \
	constant_time_compare \
	namespace_info

.PHONY: all clean smoke

all: $(PROGRAMS) libfakeclock.so

state_machine: state_machine.c
	$(CC) $(CFLAGS) $< -o $@

fork_exec: fork_exec.c
	$(CC) $(CFLAGS) $< -o $@

mmap_cow: mmap_cow.c
	$(CC) $(CFLAGS) $< -o $@

pipeline: pipeline.c
	$(CC) $(CFLAGS) $< -o $@

mini_malloc: mini_malloc.c
	$(CC) $(CFLAGS) $< -o $@

clock_user: clock_user.c
	$(CC) $(CFLAGS) $< -o $@

libfakeclock.so: preload_clock.c
	$(CC) $(CFLAGS) -fPIC -shared $< -ldl -o $@

race_counter: race_counter.c
	$(CC) $(CFLAGS) $(PTHREAD) $< -o $@

mutex_transfer: mutex_transfer.c
	$(CC) $(CFLAGS) $(PTHREAD) $< -o $@

bounded_buffer: bounded_buffer.c
	$(CC) $(CFLAGS) $(PTHREAD) $< -o $@

semaphore_dag: semaphore_dag.c
	$(CC) $(CFLAGS) $(PTHREAD) $< -o $@

parallel_sum: parallel_sum.c
	$(CC) $(CFLAGS) $(PTHREAD) $< -o $@

epoll_timer: epoll_timer.c
	$(CC) $(CFLAGS) $< -o $@

device_file: device_file.c
	$(CC) $(CFLAGS) $< -o $@

atomic_replace: atomic_replace.c
	$(CC) $(CFLAGS) $< -o $@

wal_kv: wal_kv.c
	$(CC) $(CFLAGS) $< -o $@

constant_time_compare: constant_time_compare.c
	$(CC) $(CFLAGS) $< -o $@

namespace_info: namespace_info.c
	$(CC) $(CFLAGS) $< -o $@

smoke: all
	./state_machine
	./fork_exec
	./mmap_cow
	./pipeline
	./mini_malloc
	./race_counter atomic
	./mutex_transfer
	./bounded_buffer
	./semaphore_dag
	./parallel_sum 4 100000
	./epoll_timer
	./device_file
	./constant_time_compare secret secret
	./namespace_info

clean:
	rm -f $(PROGRAMS) libfakeclock.so
