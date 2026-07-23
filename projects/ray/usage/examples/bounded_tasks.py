"""Use ray.wait to keep only a bounded number of tasks in flight."""

import time
from collections.abc import Iterable

import ray


@ray.remote(num_cpus=1)
def process(value: int) -> tuple[int, int]:
    # Different durations make completion order differ from submission order.
    time.sleep(0.05 * (5 - value % 5))
    return value, value * 10


def process_with_backpressure(
    values: Iterable[int], max_in_flight: int = 4
) -> list[tuple[int, int]]:
    """Submit work through a fixed-size window and consume ready results."""
    pending: list[ray.ObjectRef] = []
    completed: list[tuple[int, int]] = []

    for value in values:
        pending.append(process.remote(value))

        if len(pending) >= max_in_flight:
            ready, pending = ray.wait(pending, num_returns=1)
            completed.append(ray.get(ready[0]))

    while pending:
        ready, pending = ray.wait(pending, num_returns=1)
        completed.append(ray.get(ready[0]))

    return completed


def main() -> None:
    ray.init()
    try:
        results = process_with_backpressure(range(20), max_in_flight=4)
        print("completion-order results:")
        print(results)
    finally:
        ray.shutdown()


if __name__ == "__main__":
    main()
