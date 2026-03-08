from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    scratch_api_url: str = "http://localhost:3010"
    scratch_api_token: str = ""
    git_service_url: str = "http://localhost:3100"

    clerk_publishable_key: str = ""
    clerk_secret_key: str = ""

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8", "extra": "ignore"}


settings = Settings()
