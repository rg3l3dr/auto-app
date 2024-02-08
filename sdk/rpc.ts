
type RpcResponse = {
    jsonrpc: string;
    result?: any;
    error?: { code: number; message: string };
    id: number;
};

type RpcMethodHandler = (params: any) => Promise<any>;

// Handler function for greeting
async function accept_invitation(params: any): Promise<any> {
    // provide a notification to the user that an invitation has been received
    // and prompt the user to accept or reject the invitation
    return { result: true};
}


export class RPCClient {
    private uri: string;
    private websocket?: WebSocket;
    private methodHandlers: Record<string, RpcMethodHandler> = {};


    constructor(uri: string) {
        this.uri = uri;

        // Register method handlers
        this.registerMethodHandler("accept_invite", accept_invitation);
    }

    private registerMethodHandler(methodName: string, handler: RpcMethodHandler) {
        this.methodHandlers[methodName] = handler;
    }

    // Connect to the WebSocket server
    public connect() {
        this.websocket = new WebSocket(this.uri);

        this.websocket.onopen = () => {
            console.log('WebSocket Client Connected');
        };

        this.websocket.onerror = (error) => {
            console.log('Connection Error:', error);
        };

        this.websocket.onmessage = async (e) => {
            if (typeof e.data === 'string') {
                console.log('Received:', e.data);
                // Parse the incoming message as JSON
                const message = JSON.parse(e.data);
                // Check if the message is a method call
                if (message.jsonrpc === "2.0" && message.method) {
                    // Dispatch the method call
                    const response = await this.dispatchMethodCall(message.method, message.params, message.id);
                    // Send the response back to the caller
                    this.websocket!.send(JSON.stringify(response));
                }
            }
        };
    }

    async dispatchMethodCall(method: string, params: any, id: number): Promise<RpcResponse> {
        if (this.methodHandlers[method]) {
            try {
                const result = await this.methodHandlers[method](params);
                return { jsonrpc: "2.0", result, id };
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                return { jsonrpc: "2.0", error: { code: -32603, message: errorMessage }, id };
            }
        } else {
            return { jsonrpc: "2.0", error: { code: -32601, message: "Method not found" }, id };
        }
    }
    
    // Send a JSON-RPC request
    public async send(method: string, params: any[]): Promise<RpcResponse | undefined> {
        if (!this.websocket || this.websocket.readyState !== this.websocket.OPEN) {
            console.log('WebSocket is not connected.');
            return;
        }

        const request = {
            jsonrpc: '2.0',
            method: method,
            params: params,
            id: Math.floor(Math.random() * 1000),
        };

        return new Promise((resolve, reject) => {
        this.websocket!.onmessage = (e) => {
            if (typeof e.data === 'string') {
                try {
                        const response: RpcResponse = JSON.parse(e.data);
                        if (response.id === request.id) { // Match response to request
                            resolve(response);
                        }
                    } catch (error) {
                        reject(error);
                    }
                }
            };

            this.websocket!.send(JSON.stringify(request));
        });
    }

    // Close the WebSocket connection
    close() {
        if (this.websocket) {
            this.websocket.close();
            console.log('WebSocket connection closed.');
        }
    }
}