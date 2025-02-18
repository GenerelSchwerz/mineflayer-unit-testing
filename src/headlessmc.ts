import { spawn, ChildProcessWithoutNullStreams, execSync } from "child_process";
import EventEmitter from "events";
import TypedEmitter from "typed-emitter";
import { promisify } from "util";
import psTree1 from "ps-tree";
const psTree = promisify(psTree1);

function findJavaProcess(searchTerm: string): number | null {
  const command = process.platform === "win32" ? `wmic process where "name='java.exe'" get ProcessId,CommandLine` : `ps -eo pid,command`;

  try {
    const output = execSync(command, { encoding: "utf8" });
    const lines = output.split("\n");

    for (const line of lines) {
      if (line.includes(searchTerm)) {
        // Match the process
        const pidMatch = line.trim().match(/^(\d+)/); // Extract PID
        if (pidMatch) return parseInt(pidMatch[1], 10);
      }
    }
  } catch (error) {
    console.error(`Failed to find Java process: ${error}`);
  }

  return null;
}

// ---- Define output type of the program ----
interface StdoutType {
  isError: boolean;
  raw: Buffer;
}

// ---- Define argument types for each command ----
interface LaunchArgs {
  version: string;
  id?: boolean;
  commands?: boolean;
  lwjgl?: boolean;
  inmemory?: boolean;
  jndi?: boolean;
  lookup?: boolean;
  paulscode?: boolean;
  noout?: boolean;
  quit?: boolean;
  offline?: boolean;
  jvm?: string;
  retries?: number;
}

interface LoginArgs {
  username?: string; // Optional since login may prompt via web
}

interface FabricArgs {
  version: string;
  jvm?: string;
  java?: string;
  uid?: string;
  inmemory?: boolean;
}

interface ForgeArgs {
  version: string;
  uid?: string;
  refresh?: boolean;
  list?: boolean;
  inmemory?: boolean;
}

interface DownloadArgs {
  version: string;
  id?: boolean;
  snapshot?: boolean;
  release?: boolean;
  other?: boolean;
}

// ---- Define a Command Type ----
type CommandArgs =
  | { command: "launch"; args: LaunchArgs }
  | { command: "login"; args?: LoginArgs }
  | { command: "fabric"; args: FabricArgs }
  | { command: "forge"; args: ForgeArgs }
  | { command: "download"; args: DownloadArgs }
  | { command: "quit"; args?: {} };

// ---- Headless MC Class Events ----
type HeadlessMCEvents = {
  loginPrompt: (url: string) => void;
  stdout: (data: Buffer) => void;
  stderr: (data: Buffer) => void;
};

// ---- HeadlessMC Class ----
class HeadlessMC extends (EventEmitter as new () => TypedEmitter<HeadlessMCEvents>) {
  private jarPath: string;
  private javaPath: string;
  private process: ChildProcessWithoutNullStreams | null = null;
  private processID: number | null = null;

  private gameRunning: boolean = false;

  constructor(jarPath: string = "headlessmc-launcher-wrapper-2.5.0.jar", javaPath: string = "java") {
    super();
    this.jarPath = jarPath;
    this.javaPath = javaPath;
  }

  // Start HeadlessMC
  public start(): void {
    this.process = spawn(this.javaPath, ["-jar", this.jarPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // they apparently don't write to stderr. Weird.
    this.process.stdout.on("data", (data) => {
      const { isError, raw } = this.handleStdout(data);
      if (isError) {
        this.emit("stderr", raw);
      } else {
        this.emit("stdout", raw);
      }
    });

    this.process.stderr.on("data", (data) => {
      const { isError, raw } = this.handleStdout(data);
      if (isError) {
        this.emit("stderr", raw);
      } else {
        this.emit("stdout", raw);
      }
    });

    //   this.process.stderr.on("data", (data) => console.error('ERROR', data.toString()));
    //   this.process.on("error", (err) => reject(err));

    this.process.on("close", (code) => {
      this.gameRunning = false;
      if (code != null) {
        throw new Error(`HeadlessMC exited with code ${code}`); // intentional crash
      }
    });
  }

  // Send a command via stdin
  private sendCommand<T extends CommandArgs>(command: T, ...raw: string[]): void {
    if (!this.process) {
      throw new Error("HeadlessMC is not running.");
    }

    const formattedCommand = this.formatCommand(command, ...raw);
    console.log(`Sending command: ${formattedCommand}`);

    this.process.stdin.write(formattedCommand + "\n");
  }

  // Format command arguments properly
  private formatCommand<T extends CommandArgs>({ command, args }: T, ...rawArguments: string[]): string {
    let commandString = command;

    commandString += rawArguments.length > 0 ? ` ${rawArguments.join(" ")}` : "";

    if (args) {
      for (const [key, value] of Object.entries(args)) {
        if (typeof value === "boolean" && value) {
          commandString += ` -${key}`;
        } else if (typeof value === "string" || typeof value === "number") {
          commandString += ` --${key} ${value}`;
        }
      }
    }

    return commandString;
  }

  // Interpret stdout data to verify if an error
  private handleStdout(data: Buffer): StdoutType {
    const error = data.toString().includes("Exception:");
    return { isError: error, raw: data };
  }

  // Public Methods for Specific Commands

  public login(args?: LoginArgs): Promise<void> {
    this.sendCommand({ command: "login", args });

    return new Promise((resolve, reject) => {
      if (!this.process) {
        throw new Error("HeadlessMC is not running.");
      }

      this.on("stderr", (data) => {
        reject(new Error(data.toString()));
      });

      let count = 0;
      this.on("stdout", (data) => {
        count++;
        const str = data.toString();
        if (str.includes("https://")) {
          const url = str.split("https://")[1].split(" ")[0];
          this.emit("loginPrompt", `https://${url}`);
          return;
        }

        if (str.includes("Logged into")) {
          resolve();
          return;
        }

        if (count > 2) {
          reject(new Error("Login failed. Should have received prompt, then 'Logged in as'. Got:\n" + str));
        }
      });
    });
  }

  // Handle display of login code

  public launch(args: LaunchArgs): Promise<void> {
    if (args.version == null) throw new Error("Version is required for launch.");
    const version = args.version;
    delete (args as any).version; // intentional deletion.
    this.sendCommand({ command: "launch", args }, version);

    return new Promise((resolve, reject) => {
      this.on("stdout", (data: Buffer) => {
        const str = data.toString();
        if (str.includes("Exception")) {
          throw new Error(str);
        }

        // yeah, we loaded textures. good enough.
        if (str.includes("Created:")) {
          this.gameRunning = true;
          resolve();
        }
      });
    });
  }

  public fabric(args: FabricArgs): void {
    return this.sendCommand({ command: "fabric", args });
  }

  public forge(args: ForgeArgs): void {
    return this.sendCommand({ command: "forge", args });
  }

  public download(args: DownloadArgs): void {
    return this.sendCommand({ command: "download", args });
  }

  public async quit(): Promise<void> {
    if (!this.gameRunning) return this.sendCommand({ command: "quit", args: {} });
    else {
      if (this.process && this.process.pid) {
        const test = await psTree(this.process.pid);
        for (const p of test) {
          const pid = parseInt(p.PID);
          process.kill(pid, "SIGKILL");
        }
        process.kill(this.process.pid, "SIGKILL");
      }
    }
  }
}

// Example usage
(async () => {
  const headlessMC = new HeadlessMC("/home/generel/Documents/minecraft/headlessmc/headlessmc-launcher-wrapper-2.5.0.jar");

  headlessMC.on("loginPrompt", (url) => {
    console.log("Please login at:", url);
  });

  headlessMC.on("stdout", (data: Buffer) => {
    console.log("stdout:", data.toString().trim());
  });

  headlessMC.on("stderr", (data) => {
    console.error("stderr:", data.toString());
  });

  try {
    await headlessMC.start();
    //
    try {
      await headlessMC.launch({
        version: "1.20.4", 
        lwjgl:true
      });
    } catch (err) {
      if (err instanceof Error) {
        console.error("Error:", err.message);
      }
      await headlessMC.login();
    }
  } catch (err) {
    console.error("Error:", err);
  } finally {
    setTimeout(() => headlessMC.quit(), 2000);
  }
})();
