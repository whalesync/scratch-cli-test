import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Mount under /experimental so it doesn't clash with the main server
  app.setGlobalPrefix('experimental');

  const port = process.env.PORT ?? 3011;
  await app.listen(port);
  console.log(`scratch-v4-backend listening on http://localhost:${port}/experimental`);
}

bootstrap();
