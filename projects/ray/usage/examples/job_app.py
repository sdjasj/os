"""A small entrypoint intended to be submitted through Ray Jobs."""

import ray


@ray.remote(num_cpus=1)
def describe_worker(value: int) -> dict[str, int | str]:
    context = ray.get_runtime_context()
    return {
        "value": value,
        "square": value * value,
        "node_id": context.get_node_id(),
    }


def main() -> None:
    # In a Ray Job, this connects to the cluster that runs the entrypoint.
    ray.init()
    results = ray.get([describe_worker.remote(value) for value in range(4)])
    for result in results:
        print(result)


if __name__ == "__main__":
    main()
