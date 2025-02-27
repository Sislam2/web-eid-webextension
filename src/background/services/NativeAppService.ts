/*
 * Copyright (c) 2020-2023 Estonian Information System Authority
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import NativeUnavailableError from "@web-eid.js/errors/NativeUnavailableError";
import UnknownError from "@web-eid.js/errors/UnknownError";
import { deserializeError } from "@web-eid.js/utils/errorSerializer";
import libraryConfig from "@web-eid.js/config";

import { NativeFailureResponse } from "@web-eid.js/models/message/NativeResponse";
import { NativeRequest } from "@web-eid.js/models/message/NativeRequest";
import { Port } from "../../models/Browser/Runtime";
import calculateJsonSize from "../../shared/utils/calculateJsonSize";
import config from "../../config";
import { throwAfterTimeout } from "../../shared/utils/timing";

type UnwrappedPromise
  = { resolve: (value?: any) => void; reject: (reason?: any) => void }
  | null;

export enum NativeAppState {
  UNINITIALIZED,
  CONNECTING,
  CONNECTED,
  DISCONNECTED,
}

export class NativeAppServiceS {
  public state: NativeAppState = NativeAppState.UNINITIALIZED;

  private port: Port | null = null;
  private pending: UnwrappedPromise = null;
  public activeConnection: UnwrappedPromise = null;

  public version: any;

  async connect(): Promise<{ version: string }> {
    this.state = NativeAppState.CONNECTING;

    this.port = browser.runtime.connectNative(config.NATIVE_APP_NAME);
    this.port.onDisconnect.addListener(this.disconnectListener.bind(this));

    console.log("Nova conexao", this.state, this.port);

    try {
      const message = await this.nextMessage(libraryConfig.NATIVE_APP_HANDSHAKE_TIMEOUT);

      if (message.version) {
        this.version = message.version;
        this.state = NativeAppState.CONNECTED;
        new Promise((resolve, reject) => this.activeConnection = { resolve, reject });

        return message;
      }

      if (message) {
        throw new NativeUnavailableError(
          `expected native application to reply with a version, got ${JSON.stringify(message)}`
        );
      } else if (this.port.error) {
        throw new NativeUnavailableError(this.port.error.message);
      } else {
        throw new NativeUnavailableError("unexpected error");
      }
    } catch (error) {
      if (this.port.error) {
        console.error(this.port.error);
      }

      if (error instanceof Error) {
        throw error;
      } else if (this.port.error?.message) {
        throw new NativeUnavailableError(this.port.error.message);
      } else {
        throw new NativeUnavailableError("unexpected error");
      }
    }
  }

  async disconnectListener(): Promise<void> {
    config.DEBUG && console.log("Native app disconnected");
    // Accessing lastError when it exists stops chrome from throwing it unnecessarily.
    chrome?.runtime?.lastError;

    this.activeConnection?.resolve();
    this.state = NativeAppState.DISCONNECTED;

    this.pending?.reject?.(new UnknownError("native application closed the connection before a response"));
    this.pending = null;
  }

  disconnectForcefully(): void {
    this.state = NativeAppState.DISCONNECTED;

    // At this point, requests should already be resolved.
    // Rejecting a resolved promise is a NOOP.
    this.pending?.reject?.(new UnknownError("extension closed connection to native app prematurely"));
    this.pending = null;

    this.port?.disconnect();
  }

  close(): void {
    if (this.state == NativeAppState.DISCONNECTED) return;

    this.disconnectForcefully();
  }

  send<T>(message: NativeRequest): Promise<T> {
    switch (this.state) {
      case NativeAppState.CONNECTED: {
        return new Promise((resolve, reject) => {
          this.pending = { resolve, reject };

          const onResponse = async (message: T): Promise<void> => {
            config.DEBUG && console.log("Received message to native app", JSON.stringify(message));

            this.port?.onMessage.removeListener(onResponse);

            try {
              await Promise.race([
                this.activeConnection,
                throwAfterTimeout(
                  config.NATIVE_GRACEFUL_DISCONNECT_TIMEOUT,
                  new Error("Native application did not disconnect after response")
                ),
              ]);

            } catch (error) {
              console.error(error);
              this.disconnectForcefully();

            } finally {
              const error = (message as unknown as NativeFailureResponse)?.error;

              if (error) {
                reject(deserializeError(error));
              } else {
                resolve(message);
              }

              this.pending = null;
            }
          };

          this.port?.onMessage.addListener(onResponse);

          config.DEBUG && console.log("Sending message to native app", JSON.stringify(message));

          const messageSize = calculateJsonSize(message);

          if (messageSize > config.NATIVE_MESSAGE_MAX_BYTES) {
            throw new Error(`native application message exceeded ${config.NATIVE_MESSAGE_MAX_BYTES} bytes`);
          }

          this.port?.postMessage(message);
        });
      }

      case NativeAppState.UNINITIALIZED: {
        return Promise.reject(
          new Error("unable to send message, native application port is not initialized yet")
        );
      }

      case NativeAppState.CONNECTING: {
        return Promise.reject(
          new Error("unable to send message, native application port is still connecting")
        );
      }

      case NativeAppState.DISCONNECTED: {
        return Promise.reject(
          new Error("unable to send message, native application port is disconnected")
        );
      }

      default: {
        return Promise.reject(
          new Error("unable to send message, unexpected native app state")
        );
      }
    }
  }

  nextMessage(timeout: number): Promise<any> {
    return new Promise((resolve, reject) => {
      let cleanup: (() => void) | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const onMessageListener = (message: any): void => {
        cleanup?.();
        if (message.error) {
          reject(deserializeError(message.error));
        } else {
          resolve(message);
        }
      };

      const onDisconnectListener = (): void => {
        cleanup?.();
        reject(new NativeUnavailableError(
          "a message from native application was expected, but native application closed connection"
        ));
      };

      cleanup = (): void => {
        this.port?.onDisconnect.removeListener(onDisconnectListener);
        this.port?.onMessage.removeListener(onMessageListener);
        if (timer) clearTimeout(timer);
      };

      timer = setTimeout(
        () => {
          cleanup?.();
          reject(new NativeUnavailableError(
            `a message from native application was expected, but message wasn't received in ${timeout}ms`
          ));
        },
        timeout,
      );

      if (!this.port) {
        return reject(new NativeUnavailableError("missing native application port"));
      }

      this.port.onDisconnect.addListener(onDisconnectListener);
      this.port.onMessage.addListener(onMessageListener);
    });
  }
}

const nativeAppServiceM = new NativeAppServiceS();

export default class NativeAppService {

  async connect(): Promise<{ version: string }> {

    if (nativeAppServiceM.state !== NativeAppState.CONNECTED){
      console.log('Minha classe not connected', nativeAppServiceM, nativeAppServiceM.state);
      await nativeAppServiceM.connect()
    } else {
      console.log('Minha classe not cached');
    }

    return new Promise((resolve, reject) => { resolve({version: nativeAppServiceM.version}) });
  }

  async send<T>(message: NativeRequest): Promise<T> {
    return nativeAppServiceM.send(message);
  }

  close(): void {
   // let result = nativeAppServiceM.close();
    console.log('Minha classe close');

    return;
   // return result; 
  }

}