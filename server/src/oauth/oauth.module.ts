import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScratchConfigModule } from 'src/config/scratch-config.module';
import { CredentialEncryptionModule } from 'src/credential-encryption/credential-encryption.module';
import { PosthogModule } from 'src/posthog/posthog.module';
import { ScratchGitModule } from 'src/scratch-git/scratch-git.module';
import { UserModule } from 'src/users/users.module';
import { DbModule } from '../db/db.module';
import { OAuthAppCredentialResolver } from './oauth-app-credential-resolver.service';
import { OAuthController } from './oauth.controller';
import { OAuthService } from './oauth.service';
import { AirtableOAuthProvider } from './providers/airtable-oauth.provider';
import { GoHighLevelOAuthProvider } from './providers/gohighlevel-oauth.provider';
import { LinearOAuthProvider } from './providers/linear-oauth.provider';
import { NotionOAuthProvider } from './providers/notion-oauth.provider';
import { PipedriveOAuthProvider } from './providers/pipedrive-oauth.provider';
import { QuickBooksOAuthProvider } from './providers/quickbooks-oauth.provider';
import { ShopifyOAuthProvider } from './providers/shopify-oauth.provider';
import { SupabaseOAuthProvider } from './providers/supabase-oauth.provider';
import { WebflowOAuthProvider } from './providers/webflow-oauth.provider';
import { WixOAuthProvider } from './providers/wix-oauth.provider';
import { YouTubeOAuthProvider } from './providers/youtube-oauth.provider';
import { ZohoOAuthProvider } from './providers/zoho-oauth.provider';

@Module({
  imports: [
    ConfigModule,
    ScratchConfigModule,
    DbModule,
    PosthogModule,
    CredentialEncryptionModule,
    UserModule,
    ScratchGitModule,
  ],
  controllers: [OAuthController],
  providers: [
    OAuthService,
    OAuthAppCredentialResolver,
    AirtableOAuthProvider,
    GoHighLevelOAuthProvider,
    NotionOAuthProvider,
    ShopifyOAuthProvider,
    SupabaseOAuthProvider,
    WebflowOAuthProvider,
    WixOAuthProvider,
    YouTubeOAuthProvider,
    QuickBooksOAuthProvider,
    LinearOAuthProvider,
    ZohoOAuthProvider,
    PipedriveOAuthProvider,
  ],
  exports: [OAuthService],
})
export class OAuthModule {}
