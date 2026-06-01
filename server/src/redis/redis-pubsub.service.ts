import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import IORedis from 'ioredis';
import { Observable } from 'rxjs';
import { ScratchConfigService } from 'src/config/scratch-config.service';

/**
 * This service provides a pub/sub mechanism for the application and primarily powers the real-time event distribution across different components.
 *
 * The main consumer is the WebSocket gateway for pushing events back to connected client UI's and CLI services.
 */
@Injectable()
export class RedisPubSubService implements OnModuleInit, OnModuleDestroy {
  private publisher?: IORedis;
  private subscriber?: IORedis;
  private channelCallbacks: Map<string, Set<(message: string) => void>> = new Map();

  constructor(private readonly configService: ScratchConfigService) {}

  onModuleInit() {
    const redisConfig = {
      host: this.configService.getRedisHost(),
      port: this.configService.getRedisPort(),
      password: this.configService.getRedisPassword(),
      maxRetriesPerRequest: null,
    };

    this.publisher = new IORedis(redisConfig);
    this.subscriber = new IORedis(redisConfig);

    // Set up message handler for all subscribed channels
    this.subscriber.on('message', (channel: string, message: string) => {
      const callbacks = this.channelCallbacks.get(channel);
      if (callbacks) {
        callbacks.forEach((callback) => callback(message));
      }
    });
  }

  async onModuleDestroy() {
    await this.subscriber?.quit();
    await this.publisher?.quit();
  }

  /**
   * Publish a message to a Redis channel
   */
  async publish<T>(channel: string, message: T): Promise<void> {
    await this.publisher?.publish(channel, JSON.stringify(message));
  }

  /**
   * Subscribe to a Redis channel and return an Observable
   */
  subscribe<T>(channel: string): Observable<T> {
    return new Observable((observer) => {
      // Create callback for this subscription
      const callback = (message: string) => {
        try {
          const parsed: T = JSON.parse(message) as T;
          observer.next(parsed);
        } catch (error) {
          observer.error(error);
        }
      };

      // Register callback for this channel
      let callbacks = this.channelCallbacks.get(channel);
      if (!callbacks) {
        callbacks = new Set();
        this.channelCallbacks.set(channel, callbacks);
        // Subscribe to the channel if this is the first subscription
        void this.subscriber?.subscribe(channel);
      }
      callbacks.add(callback);

      // Cleanup on unsubscribe
      return () => {
        const callbacks = this.channelCallbacks.get(channel);
        if (callbacks) {
          callbacks.delete(callback);
          // Unsubscribe from Redis if no more callbacks
          if (callbacks.size === 0) {
            this.channelCallbacks.delete(channel);
            void this.subscriber?.unsubscribe(channel);
          }
        }
      };
    });
  }
}
