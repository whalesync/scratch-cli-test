from app.connectors.base import Connector
from app.registry import autodiscover

connectors: dict[str, type[Connector]] = autodiscover(__path__, Connector)
