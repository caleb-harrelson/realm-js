////////////////////////////////////////////////////////////////////////////
//
// Copyright 2020 Realm Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
////////////////////////////////////////////////////////////////////////////

import cp from "child_process";
import fetch from "node-fetch";
import path from "path";
import fs from "fs-extra";
import glob from "glob";
import deepmerge from "deepmerge";

/**
 * First level keys are file globs and the values are objects that are spread over the content of the files matching the glob.
 * @example { "config.json": { name: "overridden-name" }, "services/local-mongodb/rules/*.json": { database: "another-database" } }
 */
export type TemplateReplacements = Record<string, Record<string, unknown>>;

/* eslint-disable no-console */

export interface AppImporterOptions {
  baseUrl: string;
  username: string;
  password: string;
  realmConfigPath: string;
  appsDirectoryPath: string;
  cleanUp?: boolean;
}

export class AppImporter {
  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly realmConfigPath: string;
  private readonly appsDirectoryPath: string;

  private accessToken: string | undefined;

  constructor({ baseUrl, username, password, realmConfigPath, appsDirectoryPath, cleanUp = true }: AppImporterOptions) {
    this.baseUrl = baseUrl;
    this.username = username;
    this.password = password;
    this.realmConfigPath = realmConfigPath;
    this.appsDirectoryPath = appsDirectoryPath;

    if (cleanUp) {
      process.on("exit", () => {
        // Remove any stitch configuration
        if (fs.existsSync(this.realmConfigPath)) {
          console.log(`Deleting ${this.realmConfigPath}`);
          fs.removeSync(this.realmConfigPath);
        }
        // If there is nothing the the apps directory, lets delete it
        if (fs.existsSync(this.appsDirectoryPath)) {
          console.log(`Deleting ${this.appsDirectoryPath}`);
          fs.removeSync(this.appsDirectoryPath);
        }
      });
    }
  }

  /**
   * @param appTemplatePath The path to a template directory containing the configuration files needed to import the app.
   * @param replacements An object with file globs as keys and a replacement object as values. Allows for just-in-time replacements of configuration parameters.
   * @returns A promise of an object containing the app id.
   */
  public async importApp(appTemplatePath: string, replacements: TemplateReplacements = {}): Promise<{ appId: string }> {
    const { name: appName } = this.loadAppConfigJson(appTemplatePath);
    await this.logIn();
    const groupId = await this.getGroupId();

    // Get or create an application
    const app = await this.createApp(groupId, appName);
    const appId = app.client_app_id as string;
    // Create all secrets in parallel
    const secrets = this.loadSecretsJson(appTemplatePath);
    await Promise.all(
      Object.entries<string>(secrets).map(async ([name, value]) => {
        if (typeof value !== "string") {
          throw new Error(`Expected a secret string value for '${name}'`);
        }
        return this.createSecret(groupId, app._id, name, value);
      }),
    );

    // Determine the path of the new app
    const appPath = path.resolve(this.appsDirectoryPath, appId);
    // Copy over the app template
    this.copyAppTemplate(appPath, appTemplatePath);
    // Apply any replacements to the files before importing from them
    this.applyReplacements(appPath, replacements);

    // Import
    this.realmCli(
      "import",
      "--config-path",
      this.realmConfigPath,
      "--base-url",
      this.baseUrl,
      "--app-name",
      appName,
      "--app-id",
      appId,
      "--path",
      appPath,
      "--project-id",
      groupId,
      "--strategy",
      "replace",
      "--yes", // Bypass prompts
    );

    // Return the app id of the newly created app
    return { appId };
  }

  private get apiUrl() {
    return `${this.baseUrl}/api/admin/v3.0`;
  }

  private loadJson(filePath: string) {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      return JSON.parse(content);
    } catch (err) {
      throw new Error(`Failed to load JSON (${filePath}): ${(err as Error).message}`);
    }
  }

  private loadAppConfigJson(appTemplatePath: string) {
    const configJsonPath = path.resolve(appTemplatePath, "config.json");
    return this.loadJson(configJsonPath);
  }

  private loadSecretsJson(appTemplatePath: string) {
    const secretsJsonPath = path.resolve(appTemplatePath, "secrets.json");
    if (fs.existsSync(secretsJsonPath)) {
      return this.loadJson(secretsJsonPath);
    } else {
      return {};
    }
  }

  private copyAppTemplate(appPath: string, appTemplatePath: string) {
    // Only copy over the template, if the app doesn't already exist
    if (!fs.existsSync(appPath)) {
      fs.mkdirpSync(appPath);
      fs.copySync(appTemplatePath, appPath, {
        recursive: true,
      });
    }
  }

  private applyReplacements(appPath: string, replacements: TemplateReplacements) {
    for (const [fileGlob, replacement] of Object.entries(replacements)) {
      console.log(`Applying replacements to ${fileGlob}`);
      const files = glob.sync(fileGlob, { cwd: appPath });
      for (const relativeFilePath of files) {
        const filePath = path.resolve(appPath, relativeFilePath);
        const content = fs.readJSONSync(filePath);
        const mergedContent = deepmerge(content, replacement);
        fs.writeJSONSync(filePath, mergedContent, { spaces: 2 });
      }
    }
  }

  private realmCli(...args: string[]) {
    const cliPath = require.resolve("mongodb-realm-cli/wrapper.js");
    cp.execFileSync(cliPath, args, { stdio: "inherit" });
  }

  private async logIn() {
    const url = `${this.apiUrl}/auth/providers/local-userpass/login`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: this.username,
        password: this.password,
      }),
    });
    // Store the access and refresh tokens
    const responseBody = await response.json();
    this.accessToken = responseBody.access_token;

    // Write the stitch config file
    this.saveStitchConfig(this.username, responseBody.refresh_token, responseBody.access_token);
  }

  private saveStitchConfig(username: string, refreshToken: string, accessToken: string) {
    const realmConfig = [
      `public_api_key: ${username}`,
      `refresh_token: ${refreshToken}`,
      `access_token: ${accessToken}`,
    ];
    fs.writeFileSync(this.realmConfigPath, realmConfig.join("\n"), "utf8");
  }

  private async getProfile() {
    if (!this.accessToken) {
      throw new Error("Login before calling this method");
    }
    const url = `${this.baseUrl}/api/admin/v3.0/auth/profile`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    if (response.ok) {
      return response.json();
    } else {
      throw new Error("Failed to get users profile");
    }
  }

  private async getGroupId() {
    const profile = await this.getProfile();
    if (typeof profile === "object" && profile.roles.length === 1) {
      return profile.roles[0].group_id;
    } else {
      throw new Error("Expected user to have a role in a single group");
    }
  }

  private async createApp(groupId: string, name: string): Promise<any> {
    if (!this.accessToken) {
      throw new Error("Login before calling this method");
    }
    const url = `${this.baseUrl}/api/admin/v3.0/groups/${groupId}/apps`;
    const body = JSON.stringify({ name });
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "content-type": "application/json",
      },
      body,
    });

    if (response.ok) {
      const data = await response.json();

      return new Promise((resolve) => {
        let services = [];
        const getServices = async () => {
          console.log(`${url}/${data._id}/services`, `Bearer ${this.accessToken}`);
          const servicesRepsponse = await fetch(`${url}/${data._id}/services`, {
            headers: {
              Authorization: `Bearer ${this.accessToken}`,
              "content-type": "application/json",
            },
          });
          services = await servicesRepsponse.json();

          if (!services.length) {
            console.log("Waiting for services...", services);
            setTimeout(getServices, 1000);
          } else {
            console.log("Patching services...");
            const r = await fetch(`${url}/${data._id}/services/${services[0]._id}/config`, {
              method: "PATCH",
              headers: {
                Authorization: `Bearer ${this.accessToken}`,
                "content-type": "application/json",
              },
              body:
                '{ "sync_query": { "state": "enabled", "database_name": "test-database", "queryable_fields": {} } }',
            });

            resolve(data);
          }
        };

        setTimeout(async () => {
          getServices();
        }, 1000);

        // await new Promise((r) => setTimeout(r, 5000));
        // return data;
      });
    } else {
      throw new Error(`Failed to create app named '${name}' in group '${groupId}'`);
    }
  }

  private async createSecret(groupId: string, internalAppId: string, name: string, value: string) {
    console.log(`Creating "${name}" secret`);
    if (!this.accessToken) {
      throw new Error("Login before calling this method");
    }
    const url = `${this.baseUrl}/api/admin/v3.0/groups/${groupId}/apps/${internalAppId}/secrets`;
    const body = JSON.stringify({ name, value });
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "content-type": "application/json",
      },
      body,
    });
    if (!response.ok) {
      throw new Error(`Failed to create secred '${name}'`);
    }
  }
}
