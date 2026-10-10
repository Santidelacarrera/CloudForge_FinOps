import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AppController, EngineErrorFilter } from './app.controller';
import { AuthGuard } from './auth';
import { CoreService } from './core.service';

@Module({
  controllers: [AppController],
  providers: [CoreService, { provide: APP_GUARD, useClass: AuthGuard }, { provide: APP_FILTER, useClass: EngineErrorFilter }],
})
export class AppModule {}
