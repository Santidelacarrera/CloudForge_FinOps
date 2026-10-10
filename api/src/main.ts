import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { json } from 'express';
import { AppModule } from './app.module';

export async function createApp() {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  app.use(json({ limit: '25mb' }));
  app.enableShutdownHooks();
  return app;
}

if (require.main === module) {
  createApp().then((app) => app.listen(Number(process.env.PORT ?? 3000))).then(() => console.log('CloudForge API listening'));
}
