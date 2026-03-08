import * as dotenv from 'dotenv';
import * as path from 'path';

module.exports = () => {
  const envVars = dotenv.config({
    path: path.join(__dirname, '.env.integration'),
  });

  if (envVars.parsed) {
    for (const key in envVars.parsed) {
      console.warn(`Read ${key} from .env.integration`);
    }
  }
};
