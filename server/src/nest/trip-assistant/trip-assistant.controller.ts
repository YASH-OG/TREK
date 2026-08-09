import { Body, Controller, Get, HttpCode, HttpException, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { User } from '../../types';
import { tripAssistantRequestSchema } from '@trek/shared';
import { TripAssistantService } from './trip-assistant.service';

@Controller('api/ai/trip-assistant')
@UseGuards(JwtAuthGuard)
export class TripAssistantController {
  constructor(private readonly assistant: TripAssistantService) {}

  @Get(':sessionId')
  getSession(@CurrentUser() user: User, @Param('sessionId') sessionId: string) {
    return this.assistant.getSession(user, sessionId);
  }

  @Post('messages')
  @HttpCode(200)
  async send(@CurrentUser() user: User, @Body() body: unknown) {
    const parsed = tripAssistantRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpException({ error: 'Invalid assistant request' }, 400);
    }
    return this.assistant.handleMessage(user, parsed.data);
  }
}