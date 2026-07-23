"""Run independent Ray tasks and collect their results together."""

import time

import ray


@ray.remote(num_cpus=1)
def slow_square(value: int) -> tuple[int, int]:
    """Return both the input and its square after simulating slow work."""
    time.sleep(0.5)
    return value, value * value


def main() -> None:
    context = ray.init()
    started_at = time.perf_counter()

    try:
        # Submit every task before waiting so Ray can execute them concurrently.
        result_refs = [slow_square.remote(value) for value in range(8)]
        results = ray.get(result_refs)

        elapsed = time.perf_counter() - started_at
        print(f"dashboard: {context.dashboard_url}")
        print(f"results: {results}")
        print(f"elapsed seconds: {elapsed:.2f}")
    finally:
        ray.shutdown()


if __name__ == "__main__":
    main()
