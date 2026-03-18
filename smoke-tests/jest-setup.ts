import * as dotenv from "dotenv";
import * as path from "path";

module.exports = () => {
  const envFile = path.join(__dirname, ".env.integration");
  const envVars = dotenv.config({ path: envFile });

  if (envVars.parsed) {
    for (const key in envVars.parsed) {
      console.warn(`Read ${key} from .env.integration`);
    }
  } else {
    console.warn(
      "No .env.integration found — using environment variables directly (CI mode)",
    );
  }
};
