////////////////////////////////////////////////////////////////////////////
//
// Copyright 2022 Realm Inc.
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
import { isEqual } from "lodash";
import React, { createContext, useContext, useLayoutEffect, useRef, useState } from "react";
import Realm, { LogLevel } from "realm";

/**
 * Create a context containing the Realm app.  Should be accessed with the useApp hook.
 */
const AppContext = createContext<Realm.App | null>(null);

/**
 * Props for the AppProvider component. These replicate the options which
 * can be used to create a Realm.App instance:
 * https://www.mongodb.com/docs/realm-sdks/js/latest/Realm.App.html#~AppConfiguration
 */
type AppProviderProps = Realm.AppConfiguration & {
  children: React.ReactNode;
  appRef?: React.MutableRefObject<Realm.App | null>;
  logLevel?: Realm.App.Sync.LogLevel;
  logger?: (level: Realm.App.Sync.NumericLogLevel, message: string) => void;
};

// This is the default log level that would be useful for React Native.
const DEFAULT_LOG_LEVEL: LogLevel = "warn";

// Since the logger provides the numeric log level, we need to convert it to a
// string for the log message.
const getLogLevelString = (level: Realm.App.Sync.NumericLogLevel) => {
  switch (level) {
    case Realm.App.Sync.NumericLogLevel.Fatal:
      return "fatal";
    case Realm.App.Sync.NumericLogLevel.Error:
      return "error";
    case Realm.App.Sync.NumericLogLevel.Warn:
      return "warn";
    case Realm.App.Sync.NumericLogLevel.Info:
      return "info";
    case Realm.App.Sync.NumericLogLevel.Detail:
      return "detail";
    case Realm.App.Sync.NumericLogLevel.Debug:
      return "debug";
    case Realm.App.Sync.NumericLogLevel.Trace:
      return "trace";
    default:
      return "";
  }
};

// The default logger for the SDK is std::out, which is not useful for React
// Native. This is a simple logger that logs to the console.
function defaultLogger(level: Realm.App.Sync.NumericLogLevel, message: string) {
  const logLevelString = getLogLevelString(level);
  const logLevel = logLevelString.toUpperCase();
  const logMessage = `[${logLevel}] ${message}`;
  switch (level) {
    case Realm.App.Sync.NumericLogLevel.Error:
    case Realm.App.Sync.NumericLogLevel.Fatal:
      console.error(logMessage);
      return;
    case Realm.App.Sync.NumericLogLevel.Warn:
      console.warn(logMessage);
      return;
    default:
      console.log(logMessage);
  }
}

/**
 * React component providing a Realm App instance on the context for the
 * sync hooks to use. An `AppProvider` is required for an app to use the hooks.
 * @param appProps - The {@link Realm.AppConfiguration} for app services, passed as props.
 * @param appRef - A ref to the app instance, which can be used to access the app instance outside of the React component tree.
 * @param logLevel - The {@link Realm.App.Sync.LogLevel} to use for the app instance.
 * @param logger - A callback function to provide custom logging. It takes a {@link Realm.App.Sync.NumericLogLevel} and a message string as arguments.
 */
export const AppProvider: React.FC<AppProviderProps> = ({
  children,
  appRef,
  logLevel,
  logger = defaultLogger,
  ...appProps
}) => {
  const configuration = useRef<Realm.AppConfiguration>(appProps);

  const [app, setApp] = useState<Realm.App>(() => new Realm.App(configuration.current));

  // Support for a possible change in configuration
  if (!isEqual(appProps, configuration.current)) {
    configuration.current = appProps;

    try {
      setApp(new Realm.App(configuration.current));
    } catch (err) {
      console.error(err);
    }
  }

  useLayoutEffect(() => {
    if (appRef) {
      appRef.current = app;
      if (logLevel) {
        Realm.App.Sync.setLogger(app, logger);
        Realm.App.Sync.setLogLevel(app, logLevel);
      } else {
        Realm.App.Sync.setLogger(app, defaultLogger);
        Realm.App.Sync.setLogLevel(app, DEFAULT_LOG_LEVEL);
      }
    }
  }, [appRef, app, logLevel, logger]);

  return <AppContext.Provider value={app}>{children}</AppContext.Provider>;
};

/**
 * Hook to access the current {@link Realm.App} from the {@link AppProvider} context.
 *
 * @throws if an AppProvider does not exist in the component’s ancestors
 */
export const useApp = <
  FunctionsFactoryType extends Realm.DefaultFunctionsFactory,
  CustomDataType extends Record<string, unknown>,
>(): Realm.App<FunctionsFactoryType, CustomDataType> => {
  const app = useContext(AppContext);

  if (app === null) {
    throw new Error("No app found. Did you forget to wrap your component in an <AppProvider>?");
  }
  return app as Realm.App<FunctionsFactoryType, CustomDataType>;
};
