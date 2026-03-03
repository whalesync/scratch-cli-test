import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { AssetExtractorService } from './asset-extractor.service';
import { AssetIndexService } from './asset-index.service';

@Module({
  imports: [DbModule],
  providers: [AssetExtractorService, AssetIndexService],
  exports: [AssetExtractorService, AssetIndexService],
})
export class AssetModule {}
