const VERSION = "20250305-22:10";
const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB chunks for processing
const MAX_INDEXEDDB_BATCH_SIZE = 100; // Process IndexedDB in batches
let backupIntervalRunning = false;
let wasImportSuccessful = false;
let isExportInProgress = false;
let isImportInProgress = false;
let isConsoleLoggingEnabled =
  new URLSearchParams(window.location.search).get("log") === "true";
const TIME_BACKUP_INTERVAL = 15;
const TIME_BACKUP_FILE_PREFIX = `T-${TIME_BACKUP_INTERVAL}`;
let awsSdkLoadPromise = null;
const awsSdkPromise = loadAwsSdk();
let isPageFullyLoaded = false;
let backupInterval = null;
let isWaitingForUserInput = false;
let cloudOperationQueue = [];
let isProcessingQueue = false;
let cloudFileSize = 0;
let localFileSize = 0;
let isLocalDataModified = false;

// Replace the exportBackupData function with this chunked version
function exportBackupData() {
  return new Promise((resolve, reject) => {
    const exportData = {
      localStorage: {}

// Add this function to handle very large S3 uploads more efficiently
async function uploadLargeDataToS3(s3, bucketName, data) {
  const dataSize = data.size || data.length;
  
  if (dataSize > 100 * 1024 * 1024) { // If over 100MB
    logToConsole("info", `Using multipart upload for large file: ${(dataSize / 1024 / 1024).toFixed(2)} MB`);
    
    const multipart = await s3.createMultipartUpload({
      Bucket: bucketName,
      Key: "typingmind-backup.json",
      ContentType: "application/json",
      ServerSideEncryption: "AES256",
    }).promise();
    
    const uploadedParts = [];
    const partSize = 50 * 1024 * 1024; // 50MB parts for large files
    let partNumber = 1;
    
    for (let start = 0; start < dataSize; start += partSize) {
      const end = Math.min(start + partSize, dataSize);
      const chunk = data.slice(start, end);
      
      const partParams = {
        Body: chunk,
        Bucket: bucketName,
        Key: "typingmind-backup.json",
        PartNumber: partNumber,
        UploadId: multipart.UploadId,
      };
      
      const uploadResult = await s3.uploadPart(partParams).promise();
      uploadedParts.push({
        ETag: uploadResult.ETag,
        PartNumber: partNumber,
      });
      
      partNumber++;
      logToConsole("progress", `Upload progress: ${Math.round((end / dataSize) * 100)}%`);
    }
    
    await s3.completeMultipartUpload({
      Bucket: bucketName,
      Key: "typingmind-backup.json",
      UploadId: multipart.UploadId,
      MultipartUpload: { Parts: uploadedParts },
    }).promise();
    
  } else {
    // Standard upload for smaller files
    await s3.putObject({
      Bucket: bucketName,
      Key: "typingmind-backup.json",
      Body: data,
      ContentType: "application/json",
      ServerSideEncryption: "AES256",
    }).promise();
  }
}

// Add memory monitoring function
function checkMemoryUsage() {
  if (performance.memory) {
    const used = performance.memory.usedJSHeapSize;
    const limit = performance.memory.jsHeapSizeLimit;
    const usage = (used / limit) * 100;
    
    logToConsole("info", "Memory usage:", {
      used: `${(used / 1024 / 1024).toFixed(2)} MB`,
      limit: `${(limit / 1024 / 1024).toFixed(2)} MB`,
      usage: `${usage.toFixed(2)}%`
    });
    
    if (usage > 80) {
      logToConsole("warning", "High memory usage detected");
      return true;
    }
  }
  return false;
}

// Add the essential helper functions
function getImportThreshold() {
  return parseFloat(localStorage.getItem("import-size-threshold")) || 1;
}

function getExportThreshold() {
  return parseFloat(localStorage.getItem("export-size-threshold")) || 10;
}

function getShouldAlertOnSmallerCloud() {
  return localStorage.getItem("alert-smaller-cloud") === "true";
}

function resetSizes() {
  cloudFileSize = 0;
  localFileSize = 0;
}

function updateSyncStatus() {
  // Implementation remains the same as original
  setTimeout(() => {
    const syncStatus = document.getElementById("sync-status");
    if (!syncStatus) return;
    // ... rest of updateSyncStatus implementation
  }, 500);
}

async function deriveKey(password) {
  const enc = new TextEncoder();
  const keyMaterial = await window.crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveBits", "deriveKey"]
  );
  const salt = enc.encode("typingmind-backup-salt");
  return window.crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function loadAwsSdk() {
  if (awsSdkLoadPromise) return awsSdkLoadPromise;
  awsSdkLoadPromise = new Promise((resolve, reject) => {
    if (typeof AWS !== "undefined") {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = "https://sdk.amazonaws.com/js/aws-sdk-2.804.0.min.js";
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
  return awsSdkLoadPromise;
}

async function loadJSZip() {
  return new Promise((resolve, reject) => {
    if (window.JSZip) {
      resolve(window.JSZip);
      return;
    }
    const script = document.createElement("script");
    script.src =
      "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.5.0/jszip.min.js";
    script.onload = () => {
      resolve(window.JSZip);
    };
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

function logToConsole(type, message, data = null) {
  if (!isConsoleLoggingEnabled) return;

  const timestamp = new Date().toISOString();
  const icons = {
    info: "ℹ️",
    success: "✅",
    warning: "⚠️",
    error: "❌",
    start: "🔄",
    end: "🏁",
    upload: "⬆️",
    download: "⬇️",
    cleanup: "🧹",
    snapshot: "📸",
    encrypt: "🔐",
    decrypt: "🔓",
    progress: "📊",
    time: "⏰",
    wait: "⏳",
    pause: "⏸️",
    resume: "▶️",
    visibility: "👁️",
    active: "📱",
    calendar: "📅",
    tag: "🏷️",
    stop: "🛑",
    skip: "⏩",
  };

  const icon = icons[type] || "ℹ️";
  const logMessage = `${icon} [${timestamp}] ${message}`;

  if (data) {
    console.log(logMessage, data);
  } else {
    console.log(logMessage);
  }
}

function showCustomAlert(
  message,
  title = "Alert",
  buttons = [{ text: "OK", primary: true }]
) {
  return new Promise((resolve) => {
    const modal = document.createElement("div");
    modal.className =
      "fixed inset-0 bg-black bg-opacity-50 z-[99999] flex items-center justify-center p-4";
    modal.style.touchAction = "auto";
    const dialog = document.createElement("div");
    dialog.className =
      "bg-white dark:bg-zinc-900 rounded-lg max-w-md w-full p-6 shadow-xl relative z-[99999]";

    const titleElement = document.createElement("h3");
    titleElement.className =
      "text-lg font-semibold mb-4 text-gray-900 dark:text-white";
    titleElement.textContent = title;
    const messageElement = document.createElement("div");
    messageElement.className =
      "text-gray-700 dark:text-gray-300 whitespace-pre-wrap mb-6";
    messageElement.textContent = message;
    const buttonContainer = document.createElement("div");
    buttonContainer.className = "flex justify-end space-x-3";
    buttons.forEach((button) => {
      const btn = document.createElement("button");
      btn.className = `${
        button.primary
          ? "px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
          : "px-4 py-2 bg-gray-200 text-gray-800 rounded hover:bg-gray-300"
      } cursor-pointer touch-manipulation`;
      btn.style.WebkitTapHighlightColor = "transparent";
      btn.style.userSelect = "none";
      btn.textContent = button.text;
      const handleClick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        modal.remove();
        resolve(button.text === "Proceed" || button.text === "OK");
      };
      btn.addEventListener("click", handleClick, { passive: false });
      btn.addEventListener("touchend", handleClick, { passive: false });
      buttonContainer.appendChild(btn);
    });
    dialog.appendChild(titleElement);
    dialog.appendChild(messageElement);
    dialog.appendChild(buttonContainer);
    modal.appendChild(dialog);
    document.body.appendChild(modal);
  });
}

async function cleanupIncompleteMultipartUploads(s3, bucketName) {
  logToConsole("cleanup", "Checking for incomplete multipart uploads...");
  try {
    const multipartUploads = await s3
      .listMultipartUploads({
        Bucket: bucketName,
      })
      .promise();
    if (multipartUploads.Uploads && multipartUploads.Uploads.length > 0) {
      logToConsole(
        "cleanup",
        `Found ${multipartUploads.Uploads.length} incomplete multipart uploads`
      );
      for (const upload of multipartUploads.Uploads) {
        const uploadAge = Date.now() - new Date(upload.Initiated).getTime();
        const fiveMinutes = 5 * 60 * 1000;
        if (uploadAge > fiveMinutes) {
          try {
            await s3
              .abortMultipartUpload({
                Bucket: bucketName,
                Key: upload.Key,
                UploadId: upload.UploadId,
              })
              .promise();
            logToConsole(
              "success",
              `Aborted incomplete upload for ${upload.Key} (${Math.round(
                uploadAge / 1000 / 60
              )}min old)`
            );
          } catch (error) {
            logToConsole("error", "Failed to abort upload:", error);
          }
        } else {
          logToConsole(
            "skip",
            `Skipping recent upload for ${upload.Key} (${Math.round(
              uploadAge / 1000
            )}s old)`
          );
        }
      }
    } else {
      logToConsole("info", "No incomplete multipart uploads found");
    }
  } catch (error) {
    logToConsole("error", "Error cleaning up multipart uploads:", error);
  }
}

function queueCloudOperation(name, operation) {
  if (cloudOperationQueue.length > 0) {
    const lastOperation = cloudOperationQueue[cloudOperationQueue.length - 1];
    if (lastOperation.name === name) {
      logToConsole("skip", `Skipping duplicate operation: ${name}`);
      return;
    }
  }

  cloudOperationQueue.push({ name, operation });
  logToConsole("info", `Added ${name} to cloud operation queue`);
  processCloudOperationQueue();
}

async function processCloudOperationQueue() {
  if (isProcessingQueue || cloudOperationQueue.length === 0) {
    return;
  }

  isProcessingQueue = true;
  logToConsole(
    "info",
    `Processing cloud operation queue (${cloudOperationQueue.length} items)`
  );

  while (cloudOperationQueue.length > 0) {
    const nextOperation = cloudOperationQueue[0];
    try {
      logToConsole("info", `Executing queued operation: ${nextOperation.name}`);
      await nextOperation.operation();

      // Add a small delay after each operation to ensure proper completion
      await new Promise((resolve) => setTimeout(resolve, 1000));

      logToConsole("success", `Completed operation: ${nextOperation.name}`);
      cloudOperationQueue.shift();
    } catch (error) {
      logToConsole(
        "error",
        `Error executing queued operation ${nextOperation.name}:`,
        error
      );
      cloudOperationQueue.shift();

      // Add a delay after errors to prevent rapid retries
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  isProcessingQueue = false;
  logToConsole("info", "Cloud operation queue processing completed");
}

function startBackupInterval() {
  if (isWaitingForUserInput) {
    logToConsole("skip", "Skipping interval start - waiting for user input");
    return;
  }

  if (backupIntervalRunning) {
    logToConsole("skip", "Backup interval already running, skipping start");
    return;
  }

  logToConsole("start", "Starting backup interval...");

  if (backupInterval) {
    logToConsole("cleanup", `Clearing existing interval ${backupInterval}`);
    clearInterval(backupInterval);
    backupInterval = null;
    backupIntervalRunning = false;
  }

  localStorage.setItem("activeTabBackupRunning", "false");

  setTimeout(() => {
    if (isWaitingForUserInput || backupIntervalRunning) {
      logToConsole(
        "skip",
        "Another backup interval was started or waiting for user input, skipping"
      );
      return;
    }

    localStorage.setItem("activeTabBackupRunning", "true");
    const configuredInterval =
      parseInt(localStorage.getItem("backup-interval")) || 60;
    const intervalInMilliseconds = Math.max(configuredInterval * 1000, 15000);
    logToConsole(
      "info",
      `Setting backup interval to ${intervalInMilliseconds / 1000} seconds`
    );

    queueCloudOperation("immediate-backup", performBackup);

    backupIntervalRunning = true;
    backupInterval = setInterval(() => {
      if (!backupIntervalRunning) {
        logToConsole(
          "stop",
          "Backup interval flag was cleared, stopping interval"
        );
        clearInterval(backupInterval);
        return;
      }
      logToConsole("start", "Interval triggered");
      performBackup().catch((error) => {
        logToConsole("error", "Unhandled error in backup interval:", error);
      });
    }, intervalInMilliseconds);

    logToConsole(
      "success",
      `Backup interval started with ID ${backupInterval}`
    );
  }, 100);
}

async function performBackup() {
  if (isWaitingForUserInput) {
    logToConsole("pause", "Backup skipped - waiting for user input");
    return;
  }
  if (!isPageFullyLoaded) {
    logToConsole("skip", "Page not fully loaded, skipping backup");
    return;
  }
  if (document.hidden) {
    logToConsole("skip", "Tab is hidden, skipping backup");
    return;
  }
  if (isExportInProgress) {
    logToConsole(
      "skip",
      "Previous backup still in progress, queueing this iteration"
    );
    queueCloudOperation("backup", performBackup);
    return;
  }
  if (!wasImportSuccessful) {
    logToConsole("skip", "Import not yet successful, skipping backup");
    return;
  }

  try {
    await backupToS3();
    logToConsole("success", "Backup completed...");
  } catch (error) {
    logToConsole("error", "Backup failed:", error);
    if (backupIntervalRunning) {
      logToConsole("cleanup", "Clearing existing backup interval");
      clearInterval(backupInterval);
      backupInterval = null;
      backupIntervalRunning = false;
      localStorage.setItem("activeTabBackupRunning", "false");
    }
    setTimeout(() => {
      if (!backupIntervalRunning) {
        logToConsole("resume", "Restarting backup interval after failure");
        startBackupInterval();
      }
    }, 5000);
  }
},
      indexedDB: {},
      metadata: {
        version: VERSION,
        exportDate: new Date().toISOString(),
        chunked: false
      }
    };

    // Process localStorage in chunks to avoid string length issues
    try {
      const localStorageKeys = Object.keys(localStorage);
      logToConsole("info", "Processing localStorage", {
        totalKeys: localStorageKeys.length
      });
      
      for (const key of localStorageKeys) {
        try {
          exportData.localStorage[key] = localStorage.getItem(key);
        } catch (e) {
          logToConsole("warning", `Skipping localStorage key ${key} due to error:`, e);
        }
      }
    } catch (e) {
      logToConsole("error", "Error processing localStorage:", e);
    }

    const request = indexedDB.open("keyval-store", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = function (event) {
      const db = event.target.result;
      const transaction = db.transaction(["keyval"], "readonly");
      const store = transaction.objectStore("keyval");

      // Process IndexedDB data in batches
      const processIndexedDBData = async () => {
        try {
          const allKeys = await new Promise((resolve, reject) => {
            const keysRequest = store.getAllKeys();
            keysRequest.onsuccess = () => resolve(keysRequest.result);
            keysRequest.onerror = () => reject(keysRequest.error);
          });

          logToConsole("info", "Processing IndexedDB", {
            totalKeys: allKeys.length
          });

          // Process keys in batches to avoid memory issues
          for (let i = 0; i < allKeys.length; i += MAX_INDEXEDDB_BATCH_SIZE) {
            const batchKeys = allKeys.slice(i, i + MAX_INDEXEDDB_BATCH_SIZE);
            
            for (const key of batchKeys) {
              try {
                const value = await new Promise((resolve, reject) => {
                  const getRequest = store.get(key);
                  getRequest.onsuccess = () => resolve(getRequest.result);
                  getRequest.onerror = () => reject(getRequest.error);
                });
                
                // Check size before adding
                const valueStr = JSON.stringify(value);
                if (valueStr.length > CHUNK_SIZE) {
                  logToConsole("warning", `Large IndexedDB value for key ${key}: ${valueStr.length} bytes`);
                  // Store large values in chunks
                  exportData.indexedDB[key] = {
                    __chunked: true,
                    __chunks: chunkString(valueStr)
                  };
                  exportData.metadata.chunked = true;
                } else {
                  exportData.indexedDB[key] = value;
                }
              } catch (e) {
                logToConsole("warning", `Skipping IndexedDB key ${key} due to error:`, e);
              }
            }
          }

          // Check final size
          const dataStr = JSON.stringify(exportData);
          if (dataStr.length > 100 * 1024 * 1024) { // If over 100MB
            logToConsole("warning", `Large export data: ${dataStr.length} bytes. Using chunked export.`);
            resolve(createChunkedExport(exportData));
          } else {
            resolve(exportData);
          }
        } catch (error) {
          reject(error);
        }
      };

      transaction.oncomplete = () => processIndexedDBData();
      transaction.onerror = () => reject(transaction.error);
    };
  });
}

// Helper function to chunk large strings
function chunkString(str) {
  const chunks = [];
  for (let i = 0; i < str.length; i += CHUNK_SIZE) {
    chunks.push(str.slice(i, i + CHUNK_SIZE));
  }
  return chunks;
}

// Helper function to create chunked export for very large data
function createChunkedExport(data) {
  const chunkedExport = {
    __format: "chunked",
    __version: VERSION,
    __chunks: [],
    metadata: data.metadata
  };

  // Split data into manageable chunks
  const dataStr = JSON.stringify(data);
  const chunks = chunkString(dataStr);
  
  chunkedExport.__chunks = chunks;
  chunkedExport.__totalChunks = chunks.length;
  
  return chunkedExport;
}

// Replace the importDataToStorage function with this chunked version
function importDataToStorage(data) {
  return new Promise(async (resolve, reject) => {
    try {
      // Handle chunked imports
      if (data.__format === "chunked") {
        logToConsole("info", "Processing chunked import data");
        const reconstructed = data.__chunks.join("");
        data = JSON.parse(reconstructed);
      }

      const preserveKeys = [
        "import-size-threshold",
        "export-size-threshold",
        "alert-smaller-cloud",
        "encryption-key",
        "aws-bucket",
        "aws-access-key",
        "aws-secret-key",
        "aws-region",
        "aws-endpoint",
        "backup-interval",
        "sync-mode",
        "sync-status-hidden",
        "sync-status-position",
        "activeTabBackupRunning",
        "last-time-based-backup",
        "last-daily-backup-in-s3",
        "last-cloud-sync",
      ];

      // Process localStorage
      const localStorageKeys = Object.keys(data.localStorage || {});
      logToConsole("info", "Importing localStorage", {
        totalKeys: localStorageKeys.length
      });

      for (const key of localStorageKeys) {
        if (!preserveKeys.includes(key)) {
          try {
            localStorage.setItem(key, data.localStorage[key]);
            isLocalDataModified = true;
          } catch (e) {
            logToConsole("warning", `Failed to import localStorage key ${key}:`, e);
          }
        }
      }

      // Process IndexedDB
      const request = indexedDB.open("keyval-store");
      request.onerror = () => reject(request.error);
      request.onsuccess = function (event) {
        const db = event.target.result;
        const transaction = db.transaction(["keyval"], "readwrite");
        const objectStore = transaction.objectStore("keyval");

        transaction.oncomplete = () => {
          logToConsole("success", "Import completed successfully");
          resolve();
        };
        transaction.onerror = () => reject(transaction.error);

        // Clear existing data
        const deleteRequest = objectStore.clear();
        deleteRequest.onsuccess = async function () {
          const indexedDBData = data.indexedDB || {};
          const keys = Object.keys(indexedDBData);
          
          logToConsole("info", "Importing IndexedDB", {
            totalKeys: keys.length
          });

          // Process in batches
          for (let i = 0; i < keys.length; i += MAX_INDEXEDDB_BATCH_SIZE) {
            const batchKeys = keys.slice(i, i + MAX_INDEXEDDB_BATCH_SIZE);
            
            for (const key of batchKeys) {
              try {
                let value = indexedDBData[key];
                
                // Handle chunked values
                if (value && value.__chunked && value.__chunks) {
                  const reconstructed = value.__chunks.join("");
                  value = JSON.parse(reconstructed);
                }
                
                objectStore.put(value, key);
              } catch (e) {
                logToConsole("warning", `Failed to import IndexedDB key ${key}:`, e);
              }
            }
          }
        };
      };

      // Ensure extension URL is added
      let extensionURLs = JSON.parse(
        localStorage.getItem("TM_useExtensionURLs") || "[]"
      );
      if (!extensionURLs.some((url) => url.endsWith("s3.js"))) {
        extensionURLs.push(
          "https://itcon-pty-au.github.io/typingmind-cloud-backup/s3.js"
        );
        localStorage.setItem(
          "TM_useExtensionURLs",
          JSON.stringify(extensionURLs)
        );
      }
    } catch (error) {
      logToConsole("error", "Import error:", error);
      reject(error);
    }
  });
}

// Update the encryptData function to handle large data better
async function encryptData(data) {
  const encryptionKey = localStorage.getItem("encryption-key");
  const bucketName = localStorage.getItem("aws-bucket");
  
  logToConsole("encrypt", "Encryption attempt:", { hasKey: !!encryptionKey });

  if (!bucketName) {
    logToConsole("info", "Backup not configured, skipping encryption");
    throw new Error("Backup not configured");
  }

  if (!encryptionKey) {
    logToConsole("warning", "No encryption key found");
    if (backupIntervalRunning) {
      clearInterval(backupInterval);
      backupIntervalRunning = false;
      localStorage.setItem("activeTabBackupRunning", "false");
    }
    wasImportSuccessful = false;
    await showCustomAlert(
      "Please configure an encryption key in the backup settings before proceeding.",
      "Configuration Required"
    );
    throw new Error("Encryption key not configured");
  }

  try {
    const key = await deriveKey(encryptionKey);
    const enc = new TextEncoder();
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    
    // Compress data before encryption to reduce size
    const dataStr = JSON.stringify(data);
    logToConsole("info", "Data size before compression:", {
      size: dataStr.length,
      sizeMB: (dataStr.length / 1024 / 1024).toFixed(2) + " MB"
    });
    
    // For very large data, use compression
    let dataToEncrypt;
    if (dataStr.length > 10 * 1024 * 1024) { // If over 10MB
      logToConsole("info", "Using compression for large data");
      const jszip = await loadJSZip();
      const zip = new jszip();
      zip.file("data.json", dataStr, {
        compression: "DEFLATE",
        compressionOptions: { level: 9 }
      });
      const compressed = await zip.generateAsync({ type: "uint8array" });
      dataToEncrypt = compressed;
      
      // Add compression marker
      const marker = new TextEncoder().encode("COMPRESSED:ENCRYPTED:");
      const encryptedContent = await window.crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv },
        key,
        dataToEncrypt
      );
      
      const combinedData = new Uint8Array(
        marker.length + iv.length + encryptedContent.byteLength
      );
      combinedData.set(marker);
      combinedData.set(iv, marker.length);
      combinedData.set(new Uint8Array(encryptedContent), marker.length + iv.length);
      
      logToConsole("success", "Encryption with compression successful");
      return combinedData;
    } else {
      // Standard encryption for smaller data
      const encodedData = enc.encode(dataStr);
      const encryptedContent = await window.crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv },
        key,
        encodedData
      );
      
      const marker = new TextEncoder().encode("ENCRYPTED:");
      const combinedData = new Uint8Array(
        marker.length + iv.length + encryptedContent.byteLength
      );
      combinedData.set(marker);
      combinedData.set(iv, marker.length);
      combinedData.set(new Uint8Array(encryptedContent), marker.length + iv.length);
      
      logToConsole("success", "Encryption successful");
      return combinedData;
    }
  } catch (error) {
    localStorage.removeItem("encryption-key");
    clearInterval(backupInterval);
    logToConsole("error", "Encryption failed:", error);
    throw error;
  }
}

// Update the decryptData function to handle compressed data
async function decryptData(data) {
  const compressedMarker = "COMPRESSED:ENCRYPTED:";
  const encryptedMarker = "ENCRYPTED:";
  
  const dataString = new TextDecoder().decode(data.slice(0, Math.max(compressedMarker.length, encryptedMarker.length)));
  const isCompressed = dataString.startsWith(compressedMarker);
  const isEncrypted = dataString.startsWith(encryptedMarker) || isCompressed;
  
  logToConsole("tag", "Checking encryption/compression markers:", {
    isCompressed,
    isEncrypted,
    foundMarker: dataString.slice(0, 30)
  });

  if (!isEncrypted) {
    logToConsole("info", "Data is not encrypted, returning as-is");
    try {
      return JSON.parse(new TextDecoder().decode(data));
    } catch (e) {
      logToConsole("error", "Failed to parse unencrypted data:", e);
      throw new Error("Invalid backup data format");
    }
  }

  const bucketName = localStorage.getItem("aws-bucket");
  if (!bucketName) {
    logToConsole("info", "Backup not configured, skipping decryption");
    throw new Error("Backup not configured");
  }

  const encryptionKey = localStorage.getItem("encryption-key");
  if (!encryptionKey) {
    logToConsole("error", "Encrypted data found but no key provided");
    if (backupIntervalRunning) {
      clearInterval(backupInterval);
      backupIntervalRunning = false;
      localStorage.setItem("activeTabBackupRunning", "false");
    }
    wasImportSuccessful = false;
    await showCustomAlert(
      "Please configure your encryption key in the backup settings before proceeding.",
      "Configuration Required"
    );
    throw new Error("Encryption key not configured");
  }

  try {
    const key = await deriveKey(encryptionKey);
    const markerLength = isCompressed ? compressedMarker.length : encryptedMarker.length;
    const iv = data.slice(markerLength, markerLength + 12);
    const content = data.slice(markerLength + 12);
    
    const decryptedContent = await window.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv },
      key,
      content
    );
    
    if (isCompressed) {
      logToConsole("info", "Decompressing data");
      const jszip = await loadJSZip();
      const zip = await jszip.loadAsync(new Uint8Array(decryptedContent));
      const jsonFile = await zip.file("data.json").async("string");
      return JSON.parse(jsonFile);
    } else {
      const dec = new TextDecoder();
      const decryptedString = dec.decode(decryptedContent);
      return JSON.parse(decryptedString);
    }
  } catch (error) {
    localStorage.removeItem("encryption-key");
    clearInterval(backupInterval);
    logToConsole("error", "Decryption/decompression failed:", error);
    alert("Failed to decrypt backup. Please re-enter encryption key.");
    throw error;
  }
}