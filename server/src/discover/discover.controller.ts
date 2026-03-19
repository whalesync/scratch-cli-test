import { Controller, Get, Header, Query } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { generateDiscoverContent } from './discover-content';

@Controller('discover')
export class DiscoverController {
  private readonly apiReferenceContent: string;

  constructor() {
    // In dev (`nest start --watch`), __dirname is dist/discover/
    // Assets are copied to dist/assets/ by nest-cli.json config
    this.apiReferenceContent = readFileSync(join(__dirname, '..', '..', 'assets', 'api-reference.md'), 'utf-8');
  }

  @Get()
  @Header('Content-Type', 'text/markdown; charset=utf-8')
  getDiscoverContent(@Query('workbook') workbookId?: string): string {
    const apiBaseUrl = ScratchConfigService.getApiBaseUrl();
    return generateDiscoverContent({ workbookId, apiBaseUrl });
  }

  @Get('api-reference')
  @Header('Content-Type', 'text/markdown; charset=utf-8')
  getApiReference(): string {
    return this.apiReferenceContent;
  }
}
