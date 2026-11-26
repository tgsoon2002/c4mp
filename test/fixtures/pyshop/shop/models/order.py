from dataclasses import dataclass


@dataclass
class Order:
    id: str
    total: int

    def is_free(self):
        return self.total == 0
