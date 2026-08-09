import { Module } from '@nestjs/common';
import { TripsModule } from '../trips/trips.module';
import { TripAssistantController } from './trip-assistant.controller';
import { TripAssistantService } from './trip-assistant.service';
import { TripAssistantStore } from './trip-assistant.store';

@Module({
  imports: [TripsModule],
  controllers: [TripAssistantController],
  providers: [TripAssistantService, TripAssistantStore],
})
export class TripAssistantModule {}