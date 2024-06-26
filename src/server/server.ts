import ws from "ws";
import { ServerProtocolError } from "@socket-mesh/errors";
import { CallIdGenerator } from "../socket.js";
import { ServerSocket } from "./server-socket.js";
import { ClientSocket } from "../client/client-socket.js";
import { IncomingMessage, Server as HttpServer } from 'http';
import defaultCodec, { CodecEngine } from "@socket-mesh/formatter";
import { HandlerMap } from "../client/maps/handler-map.js";
import { AnyPacket } from "../request.js";
import { AuthEngine, defaultAuthEngine, isAuthEngine } from "./auth-engine.js";
import { handshakeHandler } from "./handlers/handshake.js";
import { ServerMiddleware } from "./middleware/server-middleware.js";
import { authenticateHandler } from "./handlers/authenticate.js";
import { removeAuthTokenHandler } from "../client/handlers/remove-auth-token.js";
import { CloseEvent, ConnectionEvent, ErrorEvent, HandshakeEvent, HeadersEvent, ListeningEvent, ServerEvent, ServerSocketEvent, SocketAuthenticateEvent, SocketAuthStateChangeEvent, SocketBadAuthTokenEvent, SocketCloseEvent, SocketConnectEvent, SocketConnectingEvent, SocketDeauthenticateEvent, SocketDisconnectEvent, SocketErrorEvent, SocketMessageEvent, SocketPingEvent, SocketPongEvent, SocketRemoveAuthTokenEvent, SocketRequestEvent, SocketResponseEvent, SocketSubscribeEvent, SocketSubscribeFailEvent, SocketSubscribeStateChangeEvent, SocketUnexpectedResponseEvent, SocketUnsubscribeEvent, SocketUpgradeEvent, WarningEvent } from "./server-event.js";
import { AsyncStreamEmitter } from "@socket-mesh/async-stream-emitter";
import { DemuxedConsumableStream, StreamEvent } from "@socket-mesh/stream-demux";
import { ServerOptions } from "./server-options.js";
import { SocketMapFromServer } from "../client/maps/socket-map.js";
import { ServerMap } from "../client/maps/server-map.js";
import { ClientMapFromServer } from "../client/maps/client-map.js";
import { subscribeHandler } from "./handlers/subscribe.js";
import { unsubscribeHandler } from "./handlers/unsubscribe.js";
import { Broker } from "./broker/broker.js";
import { SimpleBroker } from "./broker/simple-broker.js";
import { Exchange } from "./broker/exchange.js";
import { publishHandler } from "./handlers/publish.js";

export class Server<T extends ServerMap> extends AsyncStreamEmitter<ServerEvent<T>> {
	private readonly _callIdGenerator: CallIdGenerator;
	private readonly _wss: ws.WebSocketServer;
	private _isReady: boolean;
	private _isListening: boolean;
	private _handlers: HandlerMap<SocketMapFromServer<T>>;

	//| ServerSocket<TIncomingMap, TServiceMap, TOutgoingMap, TPrivateIncomingMap, TPrivateOutgoingMap, TServerState, TSocketState>
	public ackTimeoutMs: number;
	public allowClientPublish: boolean;
	public pingIntervalMs: number;
	public isPingTimeoutDisabled: boolean;
	public pingTimeoutMs: number;
	public socketChannelLimit?: number;

	public readonly auth: AuthEngine;
	public readonly brokerEngine: Broker<T['Channel']>;
	public readonly clients: { [ id: string ]: ClientSocket<ClientMapFromServer<T>> | ServerSocket<T> };
	public clientCount: number;
	public readonly codecEngine: CodecEngine;
	public readonly pendingClients: { [ id: string ]: ClientSocket<ClientMapFromServer<T>> | ServerSocket<T> };	
	public pendingClientCount: number;
	public readonly httpServer: HttpServer;

	public readonly middleware: ServerMiddleware<T>[];

	constructor(options?: ServerOptions<T>) {
		super();

		let cid = 1;

		if (!options) {
			options = {};
		}

		options.clientTracking = true;

		this.clients = {};
		this.clientCount = 0;
		this.pendingClients = {};
		this.pendingClientCount = 0;
		this.ackTimeoutMs = options.ackTimeoutMs || 10000;
		this.allowClientPublish = options.allowClientPublish ?? true;
		this.pingIntervalMs = options.pingIntervalMs || 8000;
		this.isPingTimeoutDisabled = (options.pingTimeoutMs === false);
		this.pingTimeoutMs = options.pingTimeoutMs || 20000;

		this._callIdGenerator = options.callIdGenerator || (() => {
			return cid++;
		});

		this.auth = isAuthEngine(options.authEngine) ? options.authEngine : defaultAuthEngine(options.authEngine);
		this.brokerEngine = options.brokerEngine || new SimpleBroker<T['Channel']>();
		this.codecEngine = options.codecEngine || defaultCodec;
		this.middleware = options.middleware || [];
		this.socketChannelLimit = options.socketChannelLimit;
		this.httpServer = options.server;
		this._handlers = Object.assign(
			{
				"#authenticate": authenticateHandler,
				"#handshake": handshakeHandler,
				"#publish": publishHandler,
				"#removeAuthToken": removeAuthTokenHandler,
				"#subscribe": subscribeHandler,
				"#unsubscribe": unsubscribeHandler
			},
			options.handlers
		);

		this._wss = new ws.WebSocketServer(options);

		this._wss.on('close', this.onClose.bind(this));
		this._wss.on('connection', this.onConnection.bind(this));
		this._wss.on('error', this.onError.bind(this));
		this._wss.on('headers', this.onHeaders.bind(this));
		this._wss.on('listening', this.onListening.bind(this));

		(async () => {
			for await (let { error } of this.brokerEngine.listen('error')) {
				this.emit('warning', { warning: error });
			}
		})();

		if (this.brokerEngine.isReady) {
			setTimeout(() => {
				this._isReady = true;
				this.emit('ready', {});
			}, 0);	
		} else {
			this._isReady = false;
			(async () => {
				await this.brokerEngine.listen('ready').once();
				this._isReady = true;
				this.emit('ready', {});
			})();
		}
	}

	close(keepSocketsOpen?: boolean): Promise<void> {
		this._isListening = false;

		return new Promise<void>((resolve, reject) => {
			this._wss.close((err) => {
				if (err) {
					reject(err);
					return;
				}
				resolve();
			});

			if (!keepSocketsOpen) {
				for (let socket of Object.values(this.clients)) {
					socket.disconnect();
				}
			}
		});
	}

	public get exchange(): Exchange<T['Channel']> {
		return this.brokerEngine.exchange;
	}

	public get isListening(): boolean {
		return this._isListening;
	}

	public get isReady(): boolean {
		return this._isReady;
	}

	private onClose(code: string, reason: Buffer): void {
		this.emit('close', {});
	}

	private onConnection(wsSocket: ws.WebSocket, upgradeReq: IncomingMessage): void {
/*
		if (!wsSocket.upgradeReq) {
			// Normalize ws modules to match.
			wsSocket.upgradeReq = upgradeReq;
		}
*/
		const socket = new ServerSocket<T>({
			ackTimeoutMs: this.ackTimeoutMs,
			callIdGenerator: this._callIdGenerator,
			codecEngine: this.codecEngine,
			middleware: this.middleware,
			socket: wsSocket,
			state: { server: this },
			handlers: this._handlers,
			onUnhandledRequest: this.onUnhandledRequest.bind(this)
		});

		this.pendingClientCount++;
		this.bind(this.pendingClients[socket.id] = socket);

//		ws.on('error', console.error);

		this.emit('connection', { socket, upgradeReq });

		//agSocket.exchange = this.exchange;
/*
		const inboundRawMiddleware = this._middleware[MiddlewareType.MIDDLEWARE_INBOUND_RAW];

		if (inboundRawMiddleware) {
			inboundRawMiddleware(socket.middlewareInboundRawStream);
		}

		const inboundMiddleware = this._middleware[MiddlewareType.MIDDLEWARE_INBOUND];

		if (inboundMiddleware) {
			inboundMiddleware(socket.middlewareInboundStream);
		}

		const outboundMiddleware = this._middleware[MiddlewareType.MIDDLEWARE_OUTBOUND];

		if (outboundMiddleware) {
			outboundMiddleware(socket.middlewareOutboundStream);
		}
*/
		// Emit event to signal that a socket handshake has been initiated.
		this.emit('handshake', { socket });
	}

	private bind(socket: ClientSocket<ClientMapFromServer<T>> | ServerSocket<T>) {
		if (socket.type === 'client') {
			(async () => {
				for await (let event of socket.listen()) {
					if (event.stream === 'connectAbort') {
						delete this.clients[socket.id];
					}

					if (event.stream === 'disconnect') {
						delete this.clients[socket.id];
					}

					this.emit(
						`socket${event.stream[0].toUpperCase()}${event.stream.substring(1)}` as any,
						Object.assign(
							{ socket },
							event.value
						)
					);
				}
			})();
	
			(async () => {
				for await (let event of socket.channels.listen()) {
					this.emit(
						`socket${event.stream[0].toUpperCase()}${event.stream.substring(1)}` as any,
						Object.assign(
							{ socket },
							event.value
						)
					);
				}
			})();	
		}
	}

	private onError(error: Error | string): void {
		if (typeof error === 'string') {
			error = new ServerProtocolError(error);
		}

		//this.emitError(error);
	}
	
	private onHeaders(headers: string[], request: IncomingMessage): void {
		this.emit('headers', { headers, request });
	}
	
	private onListening(): void {
		this._isListening = true;

		this.emit('listening', {});
	}

	private onUnhandledRequest(
		socket: ServerSocket<T> | ClientSocket<ClientMapFromServer<T>>,
		packet: AnyPacket<T['Service'], T['Incoming']>
	): void {

	}

	emit(event: "close", data: CloseEvent): void;
	emit(event: "connection", data: ConnectionEvent<T>): void;
	emit(event: "error", data: ErrorEvent): void;
	emit(event: "headers", data: HeadersEvent): void;
	emit(event: "handshake", data: HandshakeEvent<T>): void;
	emit(event: "listening", data: ListeningEvent): void;
	emit(event: "ready", data: {}): void;
	emit(event: 'socketAuthStateChange', data: SocketAuthStateChangeEvent<T>): void;
	emit(event: 'socketAuthenticate', data: SocketAuthenticateEvent<T>): void;
	emit(event: 'socketBadAuthToken', data: SocketBadAuthTokenEvent<T>): void;
	emit(event: 'socketClose', data: SocketCloseEvent<T>): void;
	emit(event: 'socketConnect', data: SocketConnectEvent<T>): void;
	emit(event: 'socketConnectAbort', data: SocketDisconnectEvent<T>): void;
	emit(event: 'socketConnecting', data: SocketConnectingEvent<T>): void;
	emit(event: 'socketDeauthenticate', data: SocketDeauthenticateEvent<T>): void;
	emit(event: 'socketDisconnect', data: SocketDisconnectEvent<T>): void;
	emit(event: 'socketError', data: SocketErrorEvent<T>): void;
	emit(event: 'socketMessage', data: SocketMessageEvent<T>): void;
	emit(event: 'socketPing', data: SocketPingEvent<T>): void;
	emit(event: 'socketPong', data: SocketPongEvent<T>): void;
	emit(event: 'socketRemoveAuthToken', data: SocketRemoveAuthTokenEvent<T>): void;
	emit(event: 'socketRequest', data: SocketRequestEvent<T>): void;
	emit(event: 'socketResponse', data: SocketResponseEvent<T>): void;
	emit(event: 'socketSubscribe', data: SocketSubscribeEvent<T>): void;
	emit(event: 'socketSubscribeFail', data: SocketSubscribeFailEvent<T>): void;
	emit(event: 'socketSubscribeRequest', data: SocketSubscribeEvent<T>): void;
	emit(event: 'socketSubscribeStateChange', data: SocketSubscribeStateChangeEvent<T>): void;
	emit(event: 'socketUnsubscribe', data: SocketUnsubscribeEvent<T>): void;
	emit(event: 'socketUnexpectedResponse', data: SocketUnexpectedResponseEvent<T>): void;
	emit(event: 'socketUpgrade', data: SocketUpgradeEvent<T>): void;
	emit(event: "warning", data: WarningEvent): void;
	emit(event: string, data: any): void {
		super.emit(event, data);
	}

	listen(): DemuxedConsumableStream<StreamEvent<ServerEvent<T>>>;
	listen(event: "close"): DemuxedConsumableStream<CloseEvent>;
	listen(event: "connection"): DemuxedConsumableStream<ConnectionEvent<T>>;
	listen(event: "error"): DemuxedConsumableStream<ErrorEvent>;
	listen(event: "handshake"): DemuxedConsumableStream<HandshakeEvent<T>>;
	listen(event: "headers"): DemuxedConsumableStream<HeadersEvent>;
	listen(event: "listening"): DemuxedConsumableStream<ListeningEvent>;
	listen(event: "ready"): DemuxedConsumableStream<{}>;
	listen(event: 'socketAuthStateChange'): DemuxedConsumableStream<SocketAuthStateChangeEvent<T>>;
	listen(event: 'socketAuthenticate'): DemuxedConsumableStream<SocketAuthenticateEvent<T>>;
	listen(event: 'socketBadAuthToken'): DemuxedConsumableStream<SocketBadAuthTokenEvent<T>>;
	listen(event: 'socketClose'): DemuxedConsumableStream<SocketCloseEvent<T>>;
	listen(event: 'socketConnect'): DemuxedConsumableStream<SocketConnectEvent<T>>;
	listen(event: 'socketConnectAbort'): DemuxedConsumableStream<SocketDisconnectEvent<T>>;
	listen(event: 'socketConnecting'): DemuxedConsumableStream<SocketConnectingEvent<T>>;
	listen(event: 'socketDeauthenticate'): DemuxedConsumableStream<SocketDeauthenticateEvent<T>>;
	listen(event: 'socketDisconnect'): DemuxedConsumableStream<SocketDisconnectEvent<T>>;
	listen(event: 'socketError'): DemuxedConsumableStream<SocketErrorEvent<T>>;
	listen(event: 'socketMessage'): DemuxedConsumableStream<SocketMessageEvent<T>>;
	listen(event: 'socketPing'): DemuxedConsumableStream<SocketPingEvent<T>>;
	listen(event: 'socketPong'): DemuxedConsumableStream<SocketPongEvent<T>>;
	listen(event: 'socketRemoveAuthToken'): DemuxedConsumableStream<SocketRemoveAuthTokenEvent<T>>;
	listen(event: 'socketRequest'): DemuxedConsumableStream<SocketRequestEvent<T>>;
	listen(event: 'socketResponse'): DemuxedConsumableStream<SocketResponseEvent<T>>;
	listen(event: 'socketSubscribe'): DemuxedConsumableStream<SocketSubscribeEvent<T>>;
	listen(event: 'socketSubscribeFail'): DemuxedConsumableStream<SocketSubscribeFailEvent<T>>;
	listen(event: 'socketSubscribeRequest'): DemuxedConsumableStream<SocketSubscribeEvent<T>>;
	listen(event: 'socketSubscribeStateChange'): DemuxedConsumableStream<SocketSubscribeStateChangeEvent<T>>;
	listen(event: 'socketUnsubscribe'): DemuxedConsumableStream<SocketUnsubscribeEvent<T>>;
	listen(event: 'socketUnexpectedResponse'): DemuxedConsumableStream<SocketUnexpectedResponseEvent<T>>;
	listen(event: 'socketUpgrade'): DemuxedConsumableStream<SocketUpgradeEvent<T>>;
	listen(event: "warning"): DemuxedConsumableStream<WarningEvent>;
	listen(event?: string): DemuxedConsumableStream<StreamEvent<any>> | DemuxedConsumableStream<ServerEvent<T>> {
		return super.listen(event);
	}
}
