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


import {
  ExtensionFailureResponse,
  ExtensionStatusResponse,
} from "@web-eid.js/models/message/ExtensionResponse";

import Action from "@web-eid.js/models/Action";
import VersionMismatchError from "@web-eid.js/errors/VersionMismatchError";
import { serializeError } from "@web-eid.js/utils/errorSerializer";

import NativeAppService from "../services/NativeAppService";
import checkCompatibility from "../../shared/utils/checkCompatibility";
import config from "../../config";

export default async function status(libraryVersion: string): Promise<ExtensionStatusResponse | ExtensionFailureResponse> {
  const extensionVersion = config.VERSION;
  const nativeAppService = new NativeAppService();

  try {

    const status = await nativeAppService.connect();

    const nativeApp = (
      status.version.startsWith("v")
        ? status.version.substring(1)
        : status.version
    );

    await nativeAppService.send({
      command:   "ping",
      arguments: {},
    });

    const componentVersions = {
      library:   libraryVersion,
      extension: extensionVersion,

      nativeApp,
    };

    const requiresUpdate = checkCompatibility(componentVersions);

    if (requiresUpdate.extension || requiresUpdate.nativeApp) {
      throw new VersionMismatchError(undefined, componentVersions, requiresUpdate);
    }

    return {
      action: Action.STATUS_SUCCESS,

      ...componentVersions,
    };
  } catch (error: any) {
    error.extension = extensionVersion;

    console.error("Status:", error);

    return {
      action: Action.STATUS_FAILURE,
      error:  serializeError(error),
    };
  } finally {
    // nativeAppService.close();
  }
}
