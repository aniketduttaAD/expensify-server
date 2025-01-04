import express from "express";
import { google } from "googleapis";
import cors from "cors";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

const sheet_id = process.env.SHEET_ID;

const prisma = new PrismaClient();
const auth = new google.auth.GoogleAuth({
  keyFile: "google-service-account.json",
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

// Add new user
app.post("/newUser", async (req, res) => {
  const { name, password, sheetName, sheetCreated } = req.body;
  try {
    console.log("Attempting to create a new user:", name);

    const existingUser = await prisma.user.findUnique({
      where: { username: name },
    });

    if (existingUser) {
      console.error("User already exists:", name);
      return res.status(400).json({ error: "User already exists" });
    } else {
      const hashedPassword = await bcrypt.hash(password, 10);
      const newUser = await prisma.user.create({
        data: {
          username: name,
          password: hashedPassword,
          sheetName: sheetName,
          sheetCreated: sheetCreated,
        },
      });

      console.log("Created new user:", newUser.username);

      const createSheetRequest = {
        spreadsheetId: sheet_id,
        resource: {
          requests: [
            {
              addSheet: {
                properties: { title: sheetName },
              },
            },
          ],
        },
      };

      await sheets.spreadsheets.batchUpdate(createSheetRequest);
      const initialRow = ["Date", "Detail", "Category", "Amount", "Type"];
      await sheets.spreadsheets.values.append({
        spreadsheetId: sheet_id,
        range: `${sheetName}!A:E`,
        insertDataOption: "INSERT_ROWS",
        valueInputOption: "RAW",
        requestBody: {
          values: [initialRow],
        },
      });

      console.log("Sheet created and initial row added for:", sheetName);
      return res.json(newUser);
    }
  } catch (error) {
    console.error("Error creating user account:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Check for existing user
app.post("/login", async (req, res) => {
  const { userId, password } = req.body;
  console.log(userId, password);

  try {
    console.log("Attempting login for user:", userId);

    const user = await prisma.user.findUnique({
      where: { username: userId },
    });

    if (!user) {
      console.error("User not found:", userId);
      return res.status(404).json({ error: "User not found" });
    }

    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      console.error("Incorrect password for user:", userId);
      return res.status(401).json({ error: "Incorrect password" });
    }

    console.log("Login successful for user:", userId);
    res.json(user);
  } catch (error) {
    console.error("Error during login:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Fetch data
app.get("/fetch-data/:username", async (req, res) => {
  const username = req.params.username;
  await validateSheetConnection();
  try {
    console.log("Fetching data for user:", username);

    const categoryResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: sheet_id,
      range: `${username}!C2:C`,
    });
    const amountResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: sheet_id,
      range: `${username}!D2:D`,
    });
    const typeResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: sheet_id,
      range: `${username}!E2:E`,
    });

    const categoryData = categoryResponse.data.values.map(String);
    const amountData = amountResponse.data.values.map(Number);
    const typeData = typeResponse.data.values.map(String);

    const data = {};
    for (let i = 0; i < categoryData.length; i++) {
      const category = categoryData[i];
      const amount = amountData[i];
      const type = typeData[i];
      if (!category || isNaN(amount) || amount === 0) {
        continue;
      }
      if (!data[category]) {
        data[category] = { credit: 0, debit: 0 };
      }
      if (type === "Credit") {
        data[category].credit += amount;
      } else if (type === "Debit") {
        data[category].debit += amount;
      }
    }

    const categoryResults = [];
    for (const category in data) {
      const { credit, debit } = data[category];
      const amount = Math.abs(credit - debit);
      categoryResults.push({ amount: amount, category: category });
    }

    console.log("Fetched data for user:", username);
    res.json(categoryResults);
  } catch (error) {
    console.error("Error fetching data for user:", username, error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Push data
app.post("/sheets/:username", async (req, res) => {
  const username = req.params.username;
  try {
    console.log("Pushing data for user:", username);
    const body = req.body;
    console.log(username, body);
    const rows = body.map((row) => [
      row.date,
      row.transactionDetail,
      row.category,
      parseFloat(row.amount),
      row.debitCredit,
    ]);
    console.log("Formatted rows for pushing:", rows);
    const range = `${username}!A:E`;
    console.log("Using range:", range);
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheet_id,
      range: range,
      insertDataOption: "INSERT_ROWS",
      valueInputOption: "RAW",
      requestBody: { values: rows },
    });

    console.log("Data successfully added for user:", username);
    res.json({ message: "Data added successfully" });
  } catch (error) {
    console.error("Error adding data for user:", username, error.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

const PORT = process.env.PORT || 5555;

app.listen(PORT, () => {
  console.log(`server started on port ${PORT}`);
});
