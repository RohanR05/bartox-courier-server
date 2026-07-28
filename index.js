// --- 1. Module Imports ---
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

// --- 2. Configurations & Services ---
require("dotenv").config();

const serviceAccount = require("./firebaseJWT.json");
const { initializeApp, cert } = require("firebase-admin");
const { getAuth } = require("firebase-admin/auth");

initializeApp({
  credential: cert(serviceAccount),
});

const stripe = require("stripe")(process.env.PAYMENT_SECURE);

// --- 3. Express App Setup ---
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());

// --- 4. Custom Middleware & Helper Functions ---
const verifyFBToken = async (req, res, next) => {
  const token = req.headers.authorization;

  if (!token || !token.startsWith("Bearer ")) {
    return res.status(401).send({ message: "Unauthorized Access" });
  }

  try {
    const idToken = token.split(" ")[1];

    // 1. Correct method name: verifyIdToken
    const decoded = await getAuth().verifyIdToken(idToken);

    // 2. Attach decoded user info to req so your routes can use it
    req.decodedUser = decoded;

    console.log("Decoded user:", decoded);
    next();
  } catch (err) {
    console.error("Firebase auth error:", err.message);
    return res.status(401).send({ message: "Unauthorized Access" });
  }
};

function generateTrackingId(prefix = "TRK") {
  const randomBytes = crypto.randomBytes(4).toString("hex").toUpperCase();
  const timestamp = Date.now().toString(36).toUpperCase().slice(-4);

  return `${prefix}-${timestamp}-${randomBytes}`;
}

// --- 5. Database Connection ---
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.fxlcgfl.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();

    const db = client.db("batrox_courier");
    const parcelCollection = db.collection("parcels");
    const paymentCollestion = db.collection("payments");

    app.get("/parcels", async (req, res) => {
      const query = {};
      const { email } = req.query;
      if (email) {
        query.senderEmail = email;
      }
      const options = { sort: { createdAt: -1 } };
      const cursor = parcelCollection.find(query, options);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelCollection.findOne(query);
      res.send(result);
    });

    app.post("/parcels", async (req, res) => {
      const parcel = req.body;
      parcel.createdAt = new Date();
      const result = await parcelCollection.insertOne(parcel);
      res.send(result);
    });

    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelCollection.deleteOne(query);
      res.send(result);
    });

    app.post("/create-checkout-session", async (req, res) => {
      try {
        const paymentInfo = req.body;
        const amount = Math.round(parseFloat(paymentInfo.cost) * 100);

        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          line_items: [
            {
              price_data: {
                currency: "usd",
                unit_amount: amount,
                product_data: {
                  name: paymentInfo.parcelTitle || "Parcel Delivery Fee",
                },
              },
              quantity: 1,
            },
          ],
          customer_email: paymentInfo.senderEmail,
          mode: "payment",
          metadata: {
            parcelId: paymentInfo.parcelId,
          },
          // Pass metadata down to the actual PaymentIntent so it shows up under Payments in the Dashboard
          payment_intent_data: {
            metadata: {
              parcelId: paymentInfo.parcelId,
            },
            description: `Parcel Delivery Fee for ${paymentInfo.parcelTitle || paymentInfo.parcelId}`,
          },
          success_url: `${process.env.SITE_DOMAIN}dashBoard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.SITE_DOMAIN}dashBoard/payment-cancelled`,
        });

        // Log the generated ID so you can copy-paste search it in Stripe search bar
        console.log("👉 GENERATED SESSION ID:", session.id);

        res.send({ url: session.url });
      } catch (error) {
        console.error("Stripe Checkout Error:", error);
        res.status(500).send({ error: error.message });
      }
    });

    app.patch("/payment-success", async (req, res) => {
      try {
        const sessionId = req.query.session_id;

        if (!sessionId) {
          return res.status(400).send({
            success: false,
            message: "Missing session_id query parameter",
          });
        }

        // 1. Retrieve session from Stripe
        const session = await stripe.checkout.sessions.retrieve(sessionId);

        if (session.payment_status === "paid") {
          const id = session.metadata?.parcelId;

          if (!id || !ObjectId.isValid(id)) {
            return res.status(400).send({
              success: false,
              message: "Invalid or missing parcelId in metadata",
            });
          }

          const transactionId = session.payment_intent;

          // 2. Safely process payment atomically using upsert
          const paymentData = {
            amount: session.amount_total / 100,
            currency: session.currency,
            customer_email:
              session.customer_details?.email || session.customer_email,
            parcelId: id,
            transactionId: transactionId,
            paymentStatus: session.payment_status,
            paidAt: new Date(),
          };

          // upsert: true inserts ONLY if transactionId doesn't exist yet
          const paymentResult = await paymentCollestion.updateOne(
            { transactionId: transactionId },
            { $setOnInsert: paymentData },
            { upsert: true },
          );

          // 3. Handle tracking ID update
          let trackingId;
          const existingParcel = await parcelCollection.findOne({
            _id: new ObjectId(id),
          });

          if (existingParcel?.trackingId) {
            trackingId = existingParcel.trackingId;
          } else {
            trackingId = generateTrackingId();
            await parcelCollection.updateOne(
              { _id: new ObjectId(id) },
              {
                $set: {
                  paymentStatus: "paid",
                  trackingId: trackingId,
                },
              },
            );
          }

          return res.send({
            success: true,
            message:
              paymentResult.upsertedCount > 0
                ? "Payment recorded successfully"
                : "Payment already exists",
            trackingId: trackingId,
            transactionId: transactionId,
          });
        }

        return res.status(400).send({
          success: false,
          message: "Payment status is not paid",
        });
      } catch (error) {
        console.error("Error processing payment success:", error);
        return res.status(500).send({
          success: false,
          message: error.message || "Internal server error",
        });
      }
    });

    app.get("/payments", verifyFBToken, async (req, res) => {
      const email = req.query.email;
      console.log("Query email received:", email);
      console.log("Decoded user email:", req.decodedUser?.email);

      const query = {};
      if (email) {
        if (email.toLowerCase() !== req.decodedUser?.email?.toLowerCase()) {
          return res.status(403).send({ message: "forbidden access" });
        }
        query.customer_email = email;
      }

      console.log("Constructed MongoDB Query:", query);

      const result = await paymentCollestion.find(query).toArray();
      console.log("Found records count:", result.length);

      res.send(result);
    });

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Yeahhhhhhhhh, Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Batrox Courier server");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
