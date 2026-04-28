import { UseGuards } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import type { WorkbookId } from '@spinner/shared-types';
import { Server } from 'socket.io';
import type { SocketWithUser } from 'src/auth/types';
import { WebSocketAuthGuard } from 'src/auth/websocket-auth-guard';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { WSLogger } from 'src/logger';
import { userToActor } from 'src/users/types';
import { WorkbookEventService } from './workbook-event.service';
import { WorkbookService } from './workbook.service';

@UseGuards(WebSocketAuthGuard)
@WebSocketGateway({
  cors: {
    origin: ScratchConfigService.getClientBaseUrl(),
  },
  path: '/workbook-events',
  transports: ['websocket'],
  // Configure timeouts to be more resilient to browser throttling
  pingTimeout: 60000, // 60 seconds - matches client configuration
  pingInterval: 25000, // 25 seconds - matches client configuration
  upgradeTimeout: 10000, // 10 seconds for transport upgrade
})
export class WorkbookDataGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server?: Server;

  constructor(
    readonly configService: ScratchConfigService,
    readonly workbookEventService: WorkbookEventService,
    readonly workbookService: WorkbookService,
  ) {}

  afterInit(server: Server) {
    WSLogger.info({
      message: 'Workbook data gateway initialized',
      source: 'WorkbookDataGateway',
      server: server.eventNames(),
    });
  }

  handleConnection(client: SocketWithUser) {
    WSLogger.info({
      message: 'Client connected to workbook data gateway',
      source: 'WorkbookDataGateway',
      userId: client.user?.id || 'unknown',
      auth: client.handshake.auth,
    });

    /**
     * responde with a connection confirmation message
     * register the client
     */
  }

  handleDisconnect(client: SocketWithUser) {
    WSLogger.info({
      message: 'Client disconnected from workbook data gateway',
      source: 'WorkbookDataGateway',
      userId: client.user?.id || 'unknown',
    });
  }

  @SubscribeMessage('ping')
  handleSnapshotEvents(client: SocketWithUser, data: string): void {
    WSLogger.info({
      message: 'Workbook events message received',
      source: 'WorkbookDataGateway',
      data,
      userId: client.user?.id,
    });

    this.getServer().emit('pong', 'pong');
  }

  @SubscribeMessage('subscribe')
  async handleSubscribe(
    @ConnectedSocket() client: SocketWithUser,
    @MessageBody() data: { workbookId: WorkbookId },
  ): Promise<void> {
    WSLogger.info({
      message: 'Subscribe to workbook message received',
      source: 'WorkbookDataGateway',
      data,
    });

    // the auth guard should have setup the user on the client
    if (!client.user) {
      WSLogger.error({
        message: 'User not found',
        source: 'WorkbookDataGateway',
        data,
      });
      throw new WsException('User not found');
    }

    const workbookId = data.workbookId;

    const actor = userToActor(client.user);
    // Read access: WebSocket subscribers can listen to pending workbooks so the client
    // can render the soft-delete state and receive the deletion-job progress events.
    let workbook;
    try {
      workbook = await this.workbookService.assertReadableWorkbook(actor, workbookId);
    } catch (err) {
      WSLogger.error({
        message: 'Workbook access denied or not found',
        source: 'WorkbookDataGateway',
        data,
      });
      throw new WsException(err instanceof Error ? err.message : 'Workbook not found');
    }

    const workbookObservable = this.workbookEventService.getWorkbookEvents(workbook);
    workbookObservable.subscribe((event) => {
      // todo repackage the event and send to the client
      client.emit('workbook-event', event);
    });

    // send a confirmation message to the client
    client.emit('workbook-event-subscription-confirmed', {
      workbookId,
      message: 'subscribed to workbook events',
    });
  }

  private getServer(): Server {
    if (!this.server) {
      throw new Error('Expected server to not be undefined');
    }
    return this.server;
  }
}
