import { Sandbox } from "@e2b/code-interpreter";

import { gemini, createAgent, createTool, Network, createNetwork } from "@inngest/agent-kit";

import { inngest } from "./client";
import { getSandbox, lastAssistantTextMessageContent } from "./utils";
import { object, z } from "zod";
import { PROMPT } from "@/prompt";
import prisma from "@/lib/db";

export const codeAgentFunction = inngest.createFunction(
  { id: "code-agent" },
  { event: "code-agent/run" },
  async ({ event, step }) => {
    const sandboxId = await step.run("get-sandbox-id", async () => {
      const sandbox = await Sandbox.create("genii-nextjs-test-2");
      return sandbox.sandboxId;
    });

    const codeAgent = createAgent({
      name: "code-agent",
      description: "An expert coding agent",
      system: PROMPT,
      model: gemini({ 
        model: "gemini-2.5-flash",
      }),
      tools: [
        createTool({
          name: "terminal",
          description: "Execute a shell command in the sandbox. Command will retry up to 3 times if it fails.",
          parameters: z.object({
            command: z.string(),
          }),
          handler: async ({ command }, { step }) => {
            return await step?.run("terminal", async () => {
              const maxRetries = 3;
              let lastError: string = "";
              
              for (let attempt = 1; attempt <= maxRetries; attempt++) {
                const buffers = { stdout: "", stderr: "" };
                let exitCode = 0;

                try {
                  const sandbox = await getSandbox(sandboxId);
                  const result = await sandbox.commands.run(command, {
                    onStdout: (data: string) => {
                      buffers.stdout += data;
                    },
                    onStderr: (data: string) => {
                      buffers.stderr += data;
                    },
                  });
                  
                  exitCode = result.exitCode || 0;
                  
                  // Check if command was successful
                  if (exitCode === 0) {
                    return `${buffers.stdout || buffers.stderr || 'Command executed successfully'}`;
                  }
                  
                  // If failed, prepare error message for retry
                  lastError = `Exit code ${exitCode}: ${buffers.stderr || buffers.stdout}`;
                  
                  // If this is not the last attempt, retry
                  if (attempt < maxRetries) {
                    console.warn(`Attempt ${attempt}/${maxRetries} failed. Retrying: ${command}`);
                    await new Promise(resolve => setTimeout(resolve, 500));
                    continue;
                  }
                  
                } catch (error) {
                  lastError = String(error);
                  
                  if (attempt < maxRetries) {
                    console.warn(`Attempt ${attempt}/${maxRetries} error. Retrying: ${command}`);
                    await new Promise(resolve => setTimeout(resolve, 500));
                    continue;
                  }
                }
              }
              
              // All retries failed
              return `FAILED after ${maxRetries} attempts: ${lastError}`;
            });
          },
        }),
        createTool({
          name: "writeFile",
          description: "Write or create a single file in the sandbox. Provide the file path and complete file content.",
          parameters: z.object({
            path: z.string().describe("The file path (e.g., 'app/page.tsx')"),
            content: z.string().describe("The complete file content to write"),
          }),
          handler: async ({ path, content }, { step, network }) => {
            return await step?.run("write-file", async () => {
              try {
                const sandbox = await getSandbox(sandboxId);
                await sandbox.files.write(path, content);
                
                // Update network state
                const updatedFiles = network.state.data.files || {};
                updatedFiles[path] = content;
                network.state.data.files = updatedFiles;
                
                return `File ${path} written successfully`;
              } catch (error) {
                return `Error writing file ${path}: ${error}`;
              }
            });
          },
        }),
        createTool({
          name: "readFiles",
          description: "Read files from the sandbox",
          parameters: z.object({
            files: z.array(z.string()),
          }),
          handler: async ({ files }, { step }) => {
            return await step?.run("readFiles", async () => {
              try {
                const sandbox = await getSandbox(sandboxId);
                const contents = [];
                for (const file of files) {
                  const content = await sandbox.files.read(file);
                  contents.push({ path: file, content });
                }
                return JSON.stringify(contents);
              } catch (error) {
                return "Error" + error;
              }
            });
          }, 
        }),
      ],
      lifecycle: {
        onResponse: async ({ result, network}) => {
          const lastAssistantMessageText = lastAssistantTextMessageContent(result);

          if (network) {
            // Initialize network state if not already done
            if (!network.state.data) {
              network.state.data = { completed: false, files: {} };
            }

            if (lastAssistantMessageText) {
              if (lastAssistantMessageText.includes("<task_summary>") || 
                  lastAssistantMessageText.includes("Task completed") ||
                  lastAssistantMessageText.includes("Done with the task")) {
                network.state.data.summary = lastAssistantMessageText;
                network.state.data.completed = true;
              }
            }
          }

          return result;
        },
      }
    });

    const network = createNetwork({
      name: "coding-agent-network",
      agents: [codeAgent],
      maxIter: 15,
      router: async ({network}) => {
        // Initialize state if needed
        if (!network.state.data) {
          network.state.data = { completed: false, files: {}, iterations: 0 };
        }
        
        network.state.data.iterations = (network.state.data.iterations || 0) + 1;
        
        // Stop if task is completed
        if (network.state.data.completed) {
          console.log("Task completed, stopping router");
          return undefined;
        }
        
        // Stop if max iterations reached
        if (network.state.data.iterations >= 15) {
          console.log("Max iterations reached, stopping router");
          return undefined;
        }
        
        // Continue with agent
        return codeAgent;
      }
    })

    const result = await network.run(event.data.value)

    // const isError = !result.state.data.summary || Object.keys(result.state.data.files || {}).length === 0;

    const sandboxUrl = await step.run("get-sandbox-url", async () => {
      const sandbox = await getSandbox(sandboxId);
      const host = sandbox.getHost(3000);
      return `https://${host}`;
    });

    await step.run("save-result", async () => {
      // Ensure files is a valid object, not null/undefined
      const files = result.state.data?.files || {};
      const summary = result.state.data?.summary || "Task completed";

      return await prisma.message.create({
        data: {
          content: summary,
          role: "ASSISTANT",
          type: "RESULT",
          fragment: {
            create: {
              sandboxUrl: sandboxUrl,
              title: "Fragment",
              files: files,
            }
          }
        }
      })
    })

    return { 
      url: sandboxUrl,
      title: "Fragment",
      files: result.state.data?.files || {},
      summary: result.state.data?.summary || "Task completed"
    };
  }
);
