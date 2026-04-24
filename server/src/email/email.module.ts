import { Module } from '@nestjs/common';
import { ScratchConfigModule } from 'src/config/scratch-config.module';
import { EmailService } from './email.service';

@Module({
  imports: [ScratchConfigModule],
  providers: [EmailService],
  exports: [EmailService],
})
export class EmailModule {}
