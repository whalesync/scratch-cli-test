import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CredentialEncryptionModule } from 'src/credential-encryption/credential-encryption.module';
import { PosthogModule } from 'src/posthog/posthog.module';
import { UserModule } from 'src/users/users.module';
import { DbModule } from '../db/db.module';
import { OAuthController } from './oauth.controller';
import { OAuthService } from './oauth.service';
import { NotionOAuthProvider } from './providers/notion-oauth.provider';
import { ShopifyOAuthProvider } from './providers/shopify-oauth.provider';
import { SupabaseOAuthProvider } from './providers/supabase-oauth.provider';
import { WebflowOAuthProvider } from './providers/webflow-oauth.provider';
import { WixOAuthProvider } from './providers/wix-oauth.provider';
import { YouTubeOAuthProvider } from './providers/youtube-oauth.provider';

@Module({
  imports: [ConfigModule, DbModule, PosthogModule, CredentialEncryptionModule, UserModule],
  controllers: [OAuthController],
  providers: [
    OAuthService,
    NotionOAuthProvider,
    ShopifyOAuthProvider,
    SupabaseOAuthProvider,
    WebflowOAuthProvider,
    WixOAuthProvider,
    YouTubeOAuthProvider,
  ],
  exports: [OAuthService],
})
export class OAuthModule {}
