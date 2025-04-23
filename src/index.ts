// NOTES:

// npm run build
// in epub folder to compile the cli

// node dist/index.js -e ~/Desktop/input/local/pg14838-images.epub -l ~/Desktop/input/local/pg14838_log -s -i 1 -m "fred"

// epub cli stores info in /Users/crdjm/Library/Application Support/epub/<epub basename>_<hash>.json
// Get default install working again?

import dotenv from "dotenv";
dotenv.config();
import { Command } from "commander";
import * as fs from "fs";

import getAppDataPath from "appdata-path";

import AdmZip from "adm-zip";

import * as xmldom from "@xmldom/xmldom";
const parser = new xmldom.DOMParser(); // To parse the xhtml file DOM
const serializer = new xmldom.XMLSerializer(); // To update the xhtml file DOM

// AI related imports
import { GoogleGenerativeAI } from "@google/generative-ai";
import { LMStudioClient } from "@lmstudio/sdk";

import { parseEpub } from "epubhub"; // Only using as it allows us to update the epub
// However, epubhub is missing key features such as being able to extract image data, so we use epub2 instead
// for this missing functionality. At some point, we should consider updating epubhub and using that exclusively
//
import { EPub } from "epub2";
import * as xpath from "xpath";
import * as path from "path";

const program = new Command();
let ai_max = 4; // Max number of images to generate before pausing to avoid stressing the local LLM
let ai_max_API = 2; // Max number of images to generate before pausing to avoid stressing the AI API
let ai_api_delay = 15000; // Delay between API batches in milliseconds

let logFolder: string = ""; // Locationm to write generated log file
const generateLog: boolean = true; // We may add a command line option to turn this off, but for now, always generate a log
const userData = getAppDataPath("epub"); // Where to store cache files and exploded epubs

function parseNumbers(value: string): number[] {
  return value.split(",").map((v) => Number(v.trim()));
}

program
  .version("1.0.0")
  .description("Epub CLI")
  .option("-e, --epub  [epub]", "\nepub to review/update")
  .option(
    "-l, --log [log]",
    "\nfolder in which to generate log of images and before/after alt text. Default is to generate a log next to the inout epub.",
  )
  .option("-s, --show", "\nOpen log file when done")
  .option(
    "-u, --updateMissing",
    "update all missing alt text with AI generated text",
  )
  .option(
    "--updateAll",
    "update all alt text with AI generated text even if there is existing alt text",
  )
  .option("-o, --output [epub]", "output epub")
  // .option(
  //   "-i , --image [image number]",
  //   "image number to set manual alt text, see log file for image numbers",
  // )

  .option(
    "-i, --images [image number, or comma separated list without spaces]",
    "image number(s) to set manual alt text, see log file for image numbers",
    parseNumbers,
  )

  .option(
    "--resetall",
    "reset all alt text to its original value from the input epub",
  )
  .option("--email [email]", "Email address to verify license")
  .option(
    "-g, --ignore [text]",
    "consider this alt text as insufficient and replace it with AI generated text, eg --ignore 'Image'",
  )

  // .option("--localai", "Run AI locally, rather than using the API")
  .option("--aiChoice [choice]", "Choose between API or Local AI")

  .option(
    "-c, --count [count]",
    "number of images to generate alt text for before pausing to avoid stressing the API",
  )

  .option(
    "-d, --delay [delay]",
    "delay between API call batches in milliseconds",
  )
  .option(
    "-m , --manual [alt text]",
    "manually specified alt text for image number from -i option",
  )
  // The following are depercated, use --ai or --verify now
  // \n\tUse -m _ai_ to generate AI generated text\n\tUse -m _reset_ to reset alt text to its original value\
  // \n\tUse -m _verify_ to verify the existing alt text",
  // )

  .option("--ai", "generate AI alt text for image specified with -i")
  .option(
    "--reset",
    "reset text back to what it was in the epub for the image number specified with -i",
  )
  .option(
    "-v, --verify",
    "Verify AI alt text for an individual image specified by -i",
  )
  .option("--verifyAll", "Verify AI alt text for all images in the epub") // TODO -- currently alt="" is considered missing, which is wrong, no alt attribute is missing

  .option("--metadata", "display epub metadata")

  // --alt generates alt text for a specific image, not part of the epub
  .option("-a, --alt  [image]", "image to generate alt text for")

  .parse(process.argv);

program.configureHelp({
  helpWidth: 60, // set your desired width
});

const options = program.opts();

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Types and Enums defined here

type configType = {
  email?: string;
  AIChoice?: AIType;
};

type ImageType = {
  [src: string]: {
    xhtml: string;
    alt: string | null;
    altNew: string;
    altNewBlank: boolean;
    analysis: string;
    id: string | null;
    manual: boolean;
  };
};

type ImageProcessingResult = string;
type HashMap = Record<string, ImageProcessingResult>;

enum AIRequestType {
  Verify = "verify",
  Create = "create",
}

enum AIType {
  API = "API",
  Local = "Local",
}

type AIImageRequest = {
  imgPath: string;
  existingAltText?: string | null;
  request: AIRequestType;
};

type ExcludeType = {
  [key: string]: boolean;
};

type optionsType = {
  epub?: string;
  alt?: string;
  output?: string;
  updateMissing?: boolean;
  updateAll?: boolean;
  verifyAll?: boolean;
  verify?: boolean;
  reset?: boolean;
  ai?: boolean;
  log?: string;
  image?: number;
  images?: number[];
  manual?: string;
  ignore?: string;
  show?: boolean;
  resetall?: boolean;
  // localai?: boolean;
  aiChoice?: AIType;
};

// console.log("\nimages\n");
// console.log(options.images);

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// End of Types and Enums

const configFile = path.join(userData, "config.json");
let config: configType = {};

function stringToHash(data: string): string {
  let hash = 0;

  if (data.length === 0) return "";

  for (const char of data) {
    hash ^= char.charCodeAt(0); // Bitwise XOR operation
  }

  return hash.toString();
}

if (fs.existsSync(userData) === false) {
  fs.mkdirSync(userData);
}

const genAI = process.env.GEMINI_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_KEY)
  : new GoogleGenerativeAI(""); // Empty string fallback, though API calls will fail without a valid key

// Converts local file information to a GoogleGenerativeAI.Part object.
function fileToGenerativePart(path: string, mimeType: string) {
  return {
    inlineData: {
      data: Buffer.from(fs.readFileSync(path)).toString("base64"),
      mimeType,
    },
  };
}

function bufToGenerativePart(buf: string, mimeType: string) {
  return {
    inlineData: {
      data: Buffer.from(buf).toString("base64"),
      mimeType,
    },
  };
}

let writeFileSync = function (path: string, buffer: any) {
  const permission = 438;
  let fileDescriptor: number;

  try {
    fileDescriptor = fs.openSync(path, "w", permission);
  } catch (e) {
    fs.chmodSync(path, permission);
    fileDescriptor = fs.openSync(path, "w", permission);
  }

  if (fileDescriptor) {
    fs.writeSync(fileDescriptor, buffer, 0, buffer.length, 0);
    fs.closeSync(fileDescriptor);
  }
};

if (options.email) {
  fs.writeFileSync(configFile, JSON.stringify({ email: options.email }));
  console.log("config file created");
  process.exit(0);
}

if (!fs.existsSync(configFile)) {
  console.log(
    "config file does not exist, please run 'epubai --email <email>' to create it",
  );
  process.exit(1);
}

if (fs.existsSync(configFile)) {
  config = JSON.parse(fs.readFileSync(configFile, "utf8"));
}

if (!config.AIChoice) {
  config.AIChoice = AIType.API; // Default to API
  fs.writeFileSync(configFile, JSON.stringify(config));
}

if (options.aiChoice) {
  if (options.aiChoice != AIType.API && options.aiChoice != AIType.Local) {
    console.log("Invalid AI choice, must be either 'API' or 'Local'");
    process.exit(1);
  }
  console.log("Using AI choice:", options.aiChoice);
  config.AIChoice = options.aiChoice;
  fs.writeFileSync(configFile, JSON.stringify(config));
}

if (options.ai) {
  options.manual = "_ai_";
}
if (options.reset) {
  options.manual = "_reset_";
}
if (options.verify) {
  options.manual = "_verify_";
}

if (
  (options.images && !options.manual) ||
  (options.manual && !options.images)
) {
  console.log(
    "Options -i and -m, --ai, --reset or --verify must be used together",
  );
  process.exit(1);
}

if (options.count) {
  ai_max = options.count;
  ai_max_API = ai_max;
}

if (options.delay) {
  ai_api_delay = options.delay;
}

if (options.metadata) {
  displayMetadata(options.epub);
}

processOptions(options);

async function displayMetadata(epubPath: string) {
  if (!fs.existsSync(epubPath)) {
    console.log("epub does not exist");
    process.exit(1);
  }

  try {
    const epubObject = await EPub.createAsync(epubPath);
    console.log("\nMetadata for:", path.basename(epubPath));
    console.log("------------------");
    console.log("Title:", epubObject.metadata.title);
    console.log("Creator:", epubObject.metadata.creator);
    console.log("Publisher:", epubObject.metadata.publisher);
    console.log("Language:", epubObject.metadata.language);
    console.log("Rights:", epubObject.metadata.rights);
    console.log("Modified:", epubObject.metadata.modified);
    console.log("Published:", epubObject.metadata.date);
    console.log("ISBN:", epubObject.metadata.ISBN);
    // Add any other metadata fields you want to display
  } catch (error) {
    console.error("Error reading epub metadata:", error);
    process.exit(1);
  }
}

async function processOptions(options: optionsType) {
  //  let notLicensed = true; // until proven otherwise
  let notLicensed = false; // until proven otherwise

  const email = config.email;
  if (0) {
    try {
      // Meed a way to encrypt this file, or not get the whole user list!
      const resp = await fetch(
        "https://boulderwall.com/tools/epubai/access.json",
        {
          signal: AbortSignal.timeout(2000),
        },
      );
      const respBody = await resp.text();
      const users = JSON.parse(respBody).users;

      for (let i = 0; i < users.length; i++) {
        const check = users[i].email;

        if (check === email) {
          console.log(users[i]);
          notLicensed = false;
        }
      }

      // console.log(users);
    } catch (e) {
      console.error("Error occured:", e);
    }
  }

  if (notLicensed) {
    console.log("Sorry, you are not licensed to use this tool.");
    return;
  }

  // AI related functionality
  let model: any = null;
  let client: any = null;

  // if (options.localai) {
  if (config.AIChoice == AIType.Local) {
    client = new LMStudioClient(); // TODO -- make global, and only initialize when --localai used
    model = await client.llm.model("gemma-3-12b-it");
  } else {
    model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash-preview-04-17",
    }); // gemini-2.5-flash-preview-04-17    gemini-2.0-flash
  }

  const ai_prompt =
    "You are an expert in accessibility, familiar with ADA and WCAG guidelines. Your task is to review the image and create a detailed, \
    accurate, and meaningful alt text description that makes the image accessible to all users, including those with visual impairments. If the image \
    is decorative and does not convey meaningful information, return a blank string ('').  \
    If the image is mainly white space, or a single color, return a blank string. \
    If the image is clearly decorative return a blank string.\
    If the image just contains blocks or stripes or a band of color, return a blank string,\
    Ensure the description is concise, ideally under 200 characters, and focuses on key elements and \
    context without starting with phrases like '[image / artwork of]'. \
    Only return the alt text, no explanation or reasoning behind why you chose it.";

  // const ai_prompt2 =
  //   "If the image is mainly white space, or a single color, return an empty string. \
  //   If the image is clearly decorative return an empty string.\
  //   If the image just contains blocks or stripes or a band of color, return an empty string,\
  //   If the image contains no useful content, return an empty string.\
  //   OTHERWISE: Write a short alttext description for this image. Do not include any introductory explanation or disclaimers. \
  //   Do not start with anything like 'this is an image' or 'the illustration' or 'the picture'. Just include the description. Do not make any mention of the book from which the image was taken. \
  //   Do not mention the author or publisher. Do not include any disclaimers or legalese. \
  //   If you recognise any characters in the image, it is ok to name them explicilty. ";

  // Run alttext AI locally using LM Studio
  async function describeImage(
    imagePath: string,
    useAIPrompt: string,
  ): Promise<string> {
    // Prepare the image for input
    const image = await client.files.prepareImage(imagePath); // Path to your image file

    // Generate a prediction by passing the image and prompt
    const prediction = await model.respond([
      {
        role: "user",
        content: useAIPrompt,
        images: [image],
      },
    ]);

    if (prediction.content == '""' || prediction.content == "\'\'") {
      return "";
    }

    // Output the model's response
    return prediction.content;
  }

  // Generate altText for a specific image, passed as a file or buffer
  async function generateAltText(
    imageRequest: AIImageRequest | null,
    buffer: string | null,
    mime: string | null,
  ): Promise<string> {
    const imgName = imageRequest?.imgPath || null;

    let useAIPrompt = "";
    if (imageRequest?.request == AIRequestType.Verify) {
      const existingAltText = imageRequest?.existingAltText;
      if (existingAltText && existingAltText.length > 0) {
        useAIPrompt =
          "Is the following alt text for this image correct?\n\n" +
          existingAltText +
          "\n\nIf not, briefly explain why and and suggest a replacement.";
        // Use the following guidlines to improve the alt text: '" +
        //   ai_prompt +
        //   "'";
      } else {
        useAIPrompt =
          "Is a blank alt text for this image correct?\n" +
          "You are an expert in accessibility, familiar with ADA and WCAG guidelines. Your task is to review the image and create a detailed, \
          accurate, and meaningful alt text description that makes the image accessible to all users, including those with visual impairments. If the image \
          is decorative and does not convey meaningful information, return a blank string ('').  \
          If the image is mainly white space, or a single color, return a blank string. \
          If the image is clearly decorative return a blank string.\
          If the image just contains blocks or stripes or a band of color, return a blank string \
          If a blank alt text is not correct, explain why and suggest a replacement.";
        // "Is a blank alt text for this image correct? That is, does the image have no useful content?" +
        // " If not, very briefly identify issues and suggest a replacement. Use the following guidlines to determine the al text: '" +
        // ai_prompt +
        // "'";
      }
    } else useAIPrompt = ai_prompt;
    if (imgName && config.AIChoice == AIType.Local) {
      return describeImage(imgName, useAIPrompt);
    }

    const imageParts = imgName
      ? [fileToGenerativePart(imgName, "image/jpeg")]
      : buffer && mime
        ? [bufToGenerativePart(buffer, mime)]
        : null;

    if (!imageParts) {
      console.log("Error generating alt text, no image data provided");
      return "";
    }

    const result = await model.generateContent([useAIPrompt, ...imageParts]);
    return result.response.text();
  }

  async function processImagesInBatches(
    imagePaths: AIImageRequest[],
    processImage: (
      imageRequest: AIImageRequest,
    ) => Promise<ImageProcessingResult>,
    batchSize: number,
  ): Promise<HashMap> {
    const hash: HashMap = {};

    // Helper function to process a single image and update the hash
    const processAndUpdateHash = async (imageRequest: AIImageRequest) => {
      const result = await processImage(imageRequest);
      hash[imageRequest.imgPath] = result;
    };

    // Function to run batches of promises with a concurrency limit
    const runBatches = async () => {
      let index = 0;

      // Create a loop to process batches
      while (index < imagePaths.length) {
        // console.log("Processing batch", index);
        const batch = imagePaths.slice(index, index + batchSize); // Get the current batch
        await Promise.all(batch.map(processAndUpdateHash)); // Process all items in the batch concurrently
        index += batchSize; // Move to the next batch

        if (index < imagePaths.length && config.AIChoice == AIType.API) {
          console.log("AI limit reached, pausing to avoid rate limiting...");

          await new Promise((resolve) => setTimeout(resolve, ai_api_delay));
        }
      }
    };

    await runBatches(); // Wait for all batches to complete

    return hash; // Return the final hash map
  }

  // Most of this code is for dealing with epubs, so handle exceptions here
  // Notably creating alt text for a specific image
  if (options.alt) {
    let imgName = options.alt;
    console.log("Generating alttext for '" + imgName + "'");
    if (fs.existsSync(imgName)) {
      const request: AIImageRequest = {
        imgPath: imgName,
        request: AIRequestType.Create,
      };
      const alttext = await generateAltText(request, null, null);
      console.log("alttext='" + alttext + "'");
    }
    process.exit(0);
  }

  // Logic for epub analysis follows

  // Ensure we have an epub, so we don't have to worry about it later
  if (!options.epub || !fs.existsSync(options.epub)) {
    console.log(
      "epub is required and must exist on disk, use the -e option to locate an epub for review",
    );
    process.exit(1);
  }

  const regex = /\.epub/i;
  const epubBase = path.basename(options.epub);
  // const hash = createHash(options.epub, 4); // Ensures this cache is for the original epub
  const hash = stringToHash(options.epub);
  const cache = path.join(
    userData,
    epubBase.replace(regex, "") + "_" + hash + ".json",
  );
  let opfPath: string = "";

  // console.log("Using cache: " + cache);
  // process.exit(0);

  const excludeFile = path.join(userData, "exclude.json");

  let lookup: ImageType = {};
  if (fs.existsSync(cache)) {
    if (!options.resetall) {
      lookup = JSON.parse(fs.readFileSync(cache, "utf8"));
    }
  }

  let exclude: ExcludeType = {};

  if (fs.existsSync(excludeFile)) {
    exclude = JSON.parse(fs.readFileSync(excludeFile, "utf8"));
  }
  // console.log(exclude);

  if (options.ignore) {
    if (exclude[options.ignore]) {
      console.log("Already excluded, allowing it again");
      delete exclude[options.ignore];
    } else {
      exclude[options.ignore] = true;
    }
  }
  if (options.updateMissing && Object.keys(exclude).length > 0) {
    console.log("Relace any existing alt text that matches:");
    for (const [key, value] of Object.entries(exclude)) {
      console.log("\t" + key);
    }
    console.log("Use --ignore <text> to exclude more, or allow them again");
  }

  if (options.epub && fs.existsSync(options.epub)) {
    let epubName = options.epub;
    let expandEpubFolder: string = "";
    let logIndex: string = "";
    let index: string = "";

    // Create the logging folder
    if (options.log) {
      logFolder = options.log;
    } else {
      // Construct a log folder next to the input epub with .epub replaces with _log
      const regex = /\.epub/i;
      const epubBase = path.basename(options.epub);
      logFolder = path.join(
        path.dirname(options.epub),
        epubBase.replace(regex, "_log"),
      );
    }

    // Set up the log folder
    logIndex = path.join(logFolder, "index.html");
    expandEpubFolder = path.join(logFolder, "epub");
    if (!fs.existsSync(logFolder)) {
      fs.mkdirSync(logFolder);
    }

    if (!fs.existsSync(expandEpubFolder)) {
      fs.mkdirSync(expandEpubFolder);

      const zip = new AdmZip(options.epub);
      // Expand epub into the expanded epub folder
      zip.extractAllTo(expandEpubFolder, true);
    }

    // Figure out where opf lives so we can build a relative path to the xhtml
    const container = path.join(expandEpubFolder, "META-INF", "container.xml");
    const containerXML = fs.readFileSync(container, "utf8");

    const doc = parser.parseFromString(containerXML, "text/xml");
    const nodes = xpath.select(
      `//*[local-name()='rootfile']`,
      doc,
    ) as Element[];

    if (!nodes) {
      console.log(
        "Error reading opf path from the epub, please ensure this is an epub",
      );
      process.exit(1);
    }

    // The nodes result can be different types; we need to ensure it's an array and check
    // that at least one item exists before accessing it
    opfPath = nodes[0].getAttribute("full-path") || "";
    opfPath = path.dirname(opfPath);

    index =
      "<html><head><meta charset='UTF-8'><title>Alt Text report for " +
      epubName +
      "</title>\n";
    index += "<style>\n";
    index += "tr:nth-of-type(odd) {\nbackground-color:#eee;\n}\n";
    index += ".index { text-align: center; width: 40px;}\n";
    index +=
      ".xhtml { width: 150px;word-wrap: break-word; white-space: normal;overflow-wrap: break-word; padding: 5px;}\n";
    index +=
      ".src { width: 150px;word-wrap: break-word; white-space: normal;overflow-wrap: break-word; padding: 5px;}\n";
    index += ".image { width: 200px; padding: 0px}\n";
    index +=
      ".image img { width: 200px; height: auto; display: block; margin: 0 auto;}\n";
    index += ".text { width:auto;}\n";
    index += "th, td { border: 1px solid #ccc; padding: 5px;}\n";
    index +=
      "table { width: 100%; table-layout: fixed; border-collapse: collapse}";
    index += "</style></head>\n";
    index += "<body><h2>Alt Text report for " + epubName + "</h2>\n";
    index += "<table>\n";
    index +=
      "<tr><th class='index'>Index</th><th class='xhtml'>XHTML</th><th class='src'>Image Name</th><th class='image'>Image</th><th class='text'>Alt Text</th><th class='text'>New Alt Text/Comments</th></tr>\n";

    // Scan epub, locating all images and existing alt text
    let parseepub = await parseEpub(epubName);
    const epubObject = await EPub.createAsync(epubName);

    let images: ImageType = {};
    let imageCnt = 0;

    for (let s = 0; s < parseepub.spine.length; s += 1) {
      const entry = parseepub.spine[s];
      const xhtml = entry.item.href;
      const txt = await entry.item.getText();

      const doc = parser.parseFromString(txt, "text/xml");
      const nodes = xpath.select(`//*[local-name()='img']`, doc);
      // Extract all image usage and any existing alt text
      if (nodes) {
        for (
          let n = 0;
          n < (nodes && Array.isArray(nodes) ? nodes.length : 0);
          n += 1
        ) {
          if (
            Array.isArray(nodes) &&
            nodes[n] &&
            (nodes[n] as Element).getAttribute("src")
          ) {
            const node = nodes[n] as Element;

            const src = path.basename(node.getAttribute("src") || "");
            const alt = node.hasAttribute("alt")
              ? node.getAttribute("alt")
              : null;
            const id = node.getAttribute("id");
            // console.log("DJM1", src, alt, id);
            // TODO
            // If no id, we need to add one and when done with this file, save it to the expanded epub folder

            if (!images[src]) {
              imageCnt++;
              images[src] = {
                xhtml,
                alt,
                altNew: "",
                altNewBlank: false,
                id,
                manual: false,
                analysis: "",
              };
              if (lookup[src]) {
                images[src].altNew = lookup[src].altNew;
                images[src].altNewBlank = lookup[src].altNewBlank;
                images[src].manual = lookup[src].manual;
                images[src].analysis = lookup[src].analysis;
              }
            }
          }
        }
      }

      // TODO
      // If any id's added, save the update xhtml to the expanded epub folder

      // const newTxt = serializer.serializeToString(doc);
      // fs.writeFileSync(path.join(expandEpubFolder, "epub", opfPath, xhtml), newTxt);
    }

    // Extract list of images from the manifest so we have the correct path to them in the epub
    const manifest = epubObject.manifest;

    let imageListforAI: AIImageRequest[] = [];
    // let imageAIHash: { [key: string]: string } = {};

    async function processAllImages(pass: number, altAIHash: HashMap) {
      let cnt = 0;
      const keys = Object.keys(manifest);
      for (let keyI = 0; keyI < keys.length; keyI++) {
        const key: any = keys[keyI];
        // const id = manifest[key].id;
        const href = manifest[key].href;
        const mediaType = manifest[key].mediaType;
        let src;
        if (href) src = path.basename(href);

        if (
          href &&
          src &&
          mediaType &&
          mediaType.includes("image") &&
          !mediaType.includes("svg") &&
          images[src]
        ) {
          cnt++;

          let text = "";
          const alt = images[src].alt; // || "";

          // if (cnt == options.image && options.manual == "_reset_") {
          if (options.images?.includes(cnt) && options.manual == "_reset_") {
            text = "";
            images[src].manual = false;
            images[src].altNewBlank = false;
            images[src].altNew = "";
            images[src].analysis = "";
          } else if (
            // cnt == options.image &&
            options.images?.includes(cnt) &&
            options.manual &&
            options.manual != "_ai_" &&
            options.manual != "_verify_"
          ) {
            text = options.manual;
            images[src].manual = true;
            images[src].altNew = text.trim();
            images[src].altNewBlank = false;
          } else if (
            options.verifyAll || // && alt) || // && alt.length > 0 && !exclude[alt]) ||
            // (cnt == options.image && options.manual == "_verify_") // Maybe add a new option to verify existing empty alt images?
            (options.images?.includes(cnt) && options.manual == "_verify_") // Maybe add a new option to verify existing empty alt images?
          ) {
            // Verify existing alt text
            const imgPath = path.join(expandEpubFolder, href);

            if (pass == 1) {
              imageListforAI.push({
                imgPath,
                request: AIRequestType.Verify,
                existingAltText: alt,
              });

              // console.log(
              //   "Verifying existing alt text for " +
              //     src +
              //     " (" +
              //     images[src].alt +
              //     ")",
              // );
            } else {
              text = altAIHash[imgPath];
              images[src].analysis = text.trim();
            }
          } else if (
            (options.updateMissing && alt === null) || //(alt.length == 0 || exclude[alt])) ||
            options.updateAll || // Generate AI alt text for all images regardless of existing alt text
            // (cnt == options.image &&
            (options.images?.includes(cnt) && options.manual == "_ai_")
            // &&
            // (!lookup[src] ||
            //   lookup[src].altNew.length == 0 ||
            //   (images[src].analysis && images[src].analysis.length > 0))
          ) {
            // console.log(
            //   options.updateMissing +
            //     " DJM2 Generating alt text for " +
            //     src +
            //     " (" +
            //     alt?.length +
            //     ")",
            // );

            // If no alt text, use AI to create and save back to images[src].altNew
            // We've expanded the epub, so we can just use the image
            // const img = await epubObject.getImageAsync(id);
            images[src].analysis = "";
            images[src].manual = false;
            images[src].altNewBlank = false;
            images[src].altNew = "";

            try {
              const imgPath = path.join(expandEpubFolder, href);

              if (pass == 1) {
                imageListforAI.push({ imgPath, request: AIRequestType.Create });
                // imageAIHash[imgPath] = "AI generated alt text for " + href;
              } else {
                // 2nd pass, so we have generated all alt text, now update the log file
                // We'll eventually run the alt text AI between passes in a batch, but for now...
                // The AI generated alt text will be in imageAIHash[imgPath];

                // We have generated all alt text between pass 1 and pass 2 and added to the hash
                text = altAIHash[imgPath];
                images[src].analysis = "";
                images[src].altNew = text.trim();
                if (text.trim() == "") {
                  images[src].altNewBlank = true;
                } else {
                  images[src].altNewBlank = false;
                }
              }

              images[src].manual = false;

              // TODO, ensure quotes are escaped
            } catch (err) {
              console.log(err);
              text = "<b>AI Failed to generate alt text for this image<b>";
            }
          }

          // Need to move this into 2nd pass, as we need to generate any alt text as batch after the first pass is complete
          // and update the log file in one go
          if (pass == 2 && generateLog) {
            const logImage = path.join("epub/", href);

            // Add original alt text, and give image column a max width
            const textStr = images[src].analysis.length
              ? "<span style='color:red'><i>" +
                images[src].analysis +
                "</i></span>"
              : images[src].manual
                ? "<span style='color:blue'>" + images[src].altNew + "</span>"
                : images[src].altNewBlank
                  ? "<span style='color:green'><b>AI Suggests an empty string</b></span>"
                  : images[src].altNew;

            index += "<tr>";
            const srcPath =
              path.join("epub", opfPath, images[src].xhtml) +
              "#" +
              images[src].id;
            index += "<td class='index'>" + cnt + "</td>";
            index +=
              "<td class='xhtml'><a href='" +
              srcPath +
              "' target='src'>" +
              images[src].xhtml +
              "<a/></td>";
            index += "<td class='src'>" + src + "</td><td class='image'>";
            index +=
              "<a href='" +
              srcPath +
              "' target='src'><img src='" +
              logImage +
              "'/></a>";
            index +=
              "</td><td class='text'>" +
              (alt && alt.length > 0
                ? alt
                : "<span style='color:green'><b>empty alt text</b></span>") +
              "</td><td class='text'>" +
              (textStr && textStr.length
                ? textStr
                : "<span style='color:lightblue'><center>No suggestions as yet</center></span>") +
              "</td></tr>\n";
          }
        }
      } //)
    }
    await processAllImages(1, {});
    try {
      if (imageListforAI.length > 0) {
        console.log(
          "Generating " +
            config.AIChoice +
            " alt text for " +
            imageListforAI.length +
            " image" +
            (imageListforAI.length > 1 ? "s" : ""),
        );
        // console.log(imageListforAI);
        // Batch process all images for AI alt text

        const processImage = async (
          imageRequest: AIImageRequest,
        ): Promise<string> => {
          console.log(
            "Processing image:",
            path.basename(imageRequest.imgPath),
            `(${imageRequest.request})`,
          );
          const text = await generateAltText(imageRequest, null, null);

          return text;
        };

        const batchSize = config.AIChoice == AIType.Local ? ai_max : ai_max_API;

        const resultHash = await processImagesInBatches(
          imageListforAI,
          processImage,
          batchSize,
        );
        // console.log("Final Hash:", resultHash);
        await processAllImages(2, resultHash);
        // })();
      } else {
        console.log("No AI alt text needs to be generated");
        await processAllImages(2, {});
      }
    } catch (error) {
      console.error("Error processing images:", error);
    }

    if (generateLog) {
      index += "</table></body></html>";
      fs.writeFileSync(logIndex, index);

      if (options.show) {
        const { exec } = require("child_process");
        const platform = process.platform;

        // Use the appropriate command based on the operating system
        if (platform === "darwin") {
          // macOS
          exec(`open "${logIndex}"`);
        } else if (platform === "win32") {
          // Windows
          exec(`start "" "${logIndex}"`);
        } else {
          // Linux and others
          exec(`xdg-open "${logIndex}"`);
        }
      }
    }

    // If an output epub is asked for re-do src file loop
    // but this time update the alt attribute for updated images
    // Keep a track of how many images received alt text to issue a log file
    if (options.output) {
      let updatedFiles = 0;
      for (let s = 0; s < parseepub.spine.length; s += 1) {
        const entry = parseepub.spine[s];
        const xhtml = entry.item.href;
        const txt = await entry.item.getText();

        const doc = parser.parseFromString(txt, "text/xml");
        const nodes = xpath.select(`//*[local-name()='img']`, doc) as Node[];

        // Extract all image usage and any existing alt text
        let updatedImages = 0;
        for (let n = 0; n < nodes.length; n += 1) {
          const node = nodes[n] as Element;
          if (node.getAttribute("src")) {
            const src = path.basename(node.getAttribute("src") || "");
            if (
              images[src] &&
              (images[src].altNew || images[src].altNewBlank)
            ) {
              console.log(
                "Setting alt text for " +
                  src +
                  " to '" +
                  images[src].altNew +
                  "'",
              );

              node.setAttribute("alt", images[src].altNew);
              // nodes[n].setAttribute('data-epuai', 1); This isn't valid in epub2's, if we want to flag AI added alt text, we need a better way
              // Save a cache file for epubai to use? But thay only works if you wont move the epub location?

              updatedImages++;
            }
          }
        }
        if (updatedImages > 0) {
          const newTxt = serializer.serializeToString(doc);
          await entry.item.setText(newTxt);
          updatedFiles++;
        }
      }

      // Even if there have been no updates, create the new version of the epub for consistency
      const buf = await parseepub.toBuffer();
      writeFileSync(options.output, buf);
    } else {
      // console.log(
      //   "\nNOTE: Output file not asked for. However, any changes have been noted and\nyou can use the --output option to create a new epub with updated alt text",
      // );
    }

    fs.writeFileSync(cache, JSON.stringify(images));
    fs.writeFileSync(excludeFile, JSON.stringify(exclude));

    // Object.keys(images).forEach(function (key) {
    //   console.log(key, images[key].xhtml, images[key].alt, images[key].altNew);
    // })
  }
}
