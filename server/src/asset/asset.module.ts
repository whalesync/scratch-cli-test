import { Module } from '@nestjs/common';
import { ScratchConfigModule } from 'src/config/scratch-config.module';
import { DbModule } from '../db/db.module';
import { AssetDownloadService } from './asset-download.service';
import { AssetExtractorService } from './asset-extractor.service';
import { AssetIndexService } from './asset-index.service';
import { ObjectStorageService } from './object-storage.service';

@Module({
  imports: [DbModule, ScratchConfigModule],
  providers: [AssetExtractorService, AssetIndexService, ObjectStorageService, AssetDownloadService],
  exports: [AssetExtractorService, AssetIndexService, AssetDownloadService, ObjectStorageService],
})
export class AssetModule {}
