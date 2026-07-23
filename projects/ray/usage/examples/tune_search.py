"""Search a one-dimensional objective with Ray Tune."""

from ray import tune


def objective(config: dict) -> None:
    x = config["x"]

    # Multiple reports let a Trial Scheduler inspect intermediate progress.
    for step in range(5):
        score = -((x - 3.0) ** 2) + 0.01 * step
        tune.report({"score": score, "step": step})


def main() -> None:
    tuner = tune.Tuner(
        objective,
        param_space={"x": tune.uniform(0.0, 6.0)},
        tune_config=tune.TuneConfig(
            metric="score",
            mode="max",
            num_samples=8,
        ),
    )

    results = tuner.fit()
    best = results.get_best_result(metric="score", mode="max")
    print("best config:", best.config)
    print("best score:", best.metrics["score"])


if __name__ == "__main__":
    main()
