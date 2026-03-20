import { Controller, Get, Header, Query } from '@nestjs/common';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { WSLogger } from 'src/logger';
import { generateDiscoverContent } from './discover-content';

function loadAsset(filename: string): string | null {
  // Docker `nest build` produces dist/discover/ (flat), local `nest start --watch` produces dist/src/discover/ (nested).
  // Assets are always at dist/assets/. Try both relative paths from __dirname.
  const candidates = [
    join(__dirname, '..', 'assets', filename), // flat: dist/discover/ -> dist/assets/
    join(__dirname, '..', '..', 'assets', filename), // nested: dist/src/discover/ -> dist/assets/
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      return readFileSync(path, 'utf-8');
    }
  }
  return null;
}

@Controller('discover')
export class DiscoverController {
  private readonly apiReferenceContent: string;

  constructor() {
    const content = loadAsset('api-reference.md');
    if (content) {
      this.apiReferenceContent = content;
    } else {
      WSLogger.warn({
        source: 'DiscoverController',
        message: 'Could not load api-reference.md asset, /discover/api-reference will be unavailable',
      });
      this.apiReferenceContent = '# API Reference\n\nAPI reference documentation is not available in this environment.';
    }
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
