import { Body, Controller, Post } from '@nestjs/common';
import { IsString } from 'class-validator';
import { PublishService } from './publish.service';

class ExecutePlanDto {
  @IsString() connectionId!: string;
  @IsString() planId!: string;
}

@Controller('publish')
export class PublishController {
  constructor(private readonly publishService: PublishService) {}

  @Post('execute')
  async executePlan(@Body() body: ExecutePlanDto): Promise<{ ok: boolean }> {
    await this.publishService.executePlan(body.connectionId, body.planId);
    return { ok: true };
  }
}
