"""Train a tiny PyTorch model with two Ray Train CPU workers."""

import torch
from ray import train
from ray.train import ScalingConfig
from ray.train.torch import TorchTrainer
from torch import nn
from torch.utils.data import DataLoader, TensorDataset


def train_loop_per_worker(config: dict) -> None:
    torch.manual_seed(7)

    features = torch.linspace(-1.0, 1.0, steps=256).reshape(-1, 1)
    targets = 2.0 * features + 1.0
    dataset = TensorDataset(features, targets)
    loader = DataLoader(dataset, batch_size=config["batch_size"], shuffle=True)
    loader = train.torch.prepare_data_loader(loader)

    model = nn.Linear(1, 1)
    model = train.torch.prepare_model(model)
    optimizer = torch.optim.SGD(model.parameters(), lr=config["lr"])
    loss_function = nn.MSELoss()

    for epoch in range(config["epochs"]):
        if train.get_context().get_world_size() > 1:
            loader.sampler.set_epoch(epoch)

        last_loss = 0.0
        for batch_features, batch_targets in loader:
            prediction = model(batch_features)
            loss = loss_function(prediction, batch_targets)

            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            last_loss = loss.item()

        train.report({"loss": last_loss, "epoch": epoch})


def main() -> None:
    trainer = TorchTrainer(
        train_loop_per_worker,
        train_loop_config={
            "batch_size": 32,
            "epochs": 5,
            "lr": 0.1,
        },
        scaling_config=ScalingConfig(
            num_workers=2,
            use_gpu=False,
            resources_per_worker={"CPU": 1},
        ),
    )

    result = trainer.fit()
    print("final metrics:", result.metrics)


if __name__ == "__main__":
    main()
