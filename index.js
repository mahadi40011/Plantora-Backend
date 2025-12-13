require("dotenv").config();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const port = process.env.PORT || 3000;
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf-8"
);
const serviceAccount = JSON.parse(decoded);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();
// middleware
app.use(
  cors({
    origin: [process.env.CLIENT_DOMAIN],
    credentials: true,
    optionSuccessStatus: 200,
  })
);
app.use(express.json());

// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  console.log(token);
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    console.log(decoded);
    next();
  } catch (err) {
    console.log(err);
    return res.status(401).send({ message: "Unauthorized Access!", err });
  }
};

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
async function run() {
  try {
    const db = client.db("Plantora_DB");
    const plantsCollection = db.collection("Plants");
    const ordersCollection = db.collection("Orders");
    const usersCollection = db.collection("Users");
    const becomeSellerCollection = db.collection("become-seller");

    //send 1 data to database
    app.post("/plants", async (req, res) => {
      const plantData = req.body;
      console.log(plantData);
      const result = await plantsCollection.insertOne(plantData);
      res.send(result);
    });

    // get all data from database
    app.get("/plants", async (req, res) => {
      const result = await plantsCollection.find().toArray();
      res.send(result);
    });

    // get a single data from database
    app.get("/plants/:id", async (req, res) => {
      const { id } = req.params;
      const query = { _id: new ObjectId(id) };
      const result = await plantsCollection.findOne(query);
      res.send(result);
    });

    //Payment endPint
    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: paymentInfo?.name,
                description: paymentInfo?.description,
                images: [paymentInfo?.image],
              },
              unit_amount: paymentInfo?.price * 100,
            },
            quantity: paymentInfo?.quantity,
          },
        ],
        customer_email: paymentInfo?.customer?.email,
        mode: "payment",
        metadata: {
          plantId: paymentInfo?.plantId,
          customer: paymentInfo?.customer?.email,
        },
        success_url: `${process.env.CLIENT_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_DOMAIN}/plant/${paymentInfo?.plantId}`,
      });
      res.send({ url: session.url });
    });

    app.post("/payment-success", async (req, res) => {
      const { sessionId } = req.body;
      const session = await stripe.checkout.sessions.retrieve(sessionId);

      const plant = await plantsCollection.findOne({
        _id: new ObjectId(session.metadata.plantId),
      });

      const order = await ordersCollection.findOne({
        transactionId: session.payment_intent,
      });

      if ((sessionId.status = "complete" && plant && !order)) {
        // Order Information
        const orderInfo = {
          plantId: session.metadata.plantId,
          transactionId: session.payment_intent,
          customer: session.metadata.customer,
          status: "pending",
          seller: plant.seller,
          image: plant.image,
          name: plant.name,
          category: plant.category,
          quantity: 1,
          price: session.amount_total / 100,
        };

        const result = await ordersCollection.insertOne(orderInfo);

        await plantsCollection.updateOne(
          {
            _id: new ObjectId(session.metadata.plantId),
          },
          { $inc: { quantity: -1 } }
        );
        return res.send({
          transactionId: session.payment_intent,
          orderId: result.insertedId,
        });
      }
      res.send({
        transactionId: session.payment_intent,
        orderId: order._id,
      });
    });

    // get all orders for a customer by email
    app.get("/orders", verifyJWT, async (req, res) => {
      const query = { customer: req.tokenEmail };
      const result = await ordersCollection.find(query).toArray();
      res.send(result);
    });

    // get all plants for a seller by email
    app.get("/inventory/:email", async (req, res) => {
      try {
        const { email } = req.params;
        const query = { "seller.email": email };

        const result = await plantsCollection.find(query).toArray();
        res.status(200).json(result);
      } catch (error) {
        res.status(500).json({ message: "Server error", error });
      }
    });

    // get all orders for a seller by email
    app.get("/manage-orders/:email", async (req, res) => {
      try {
        const { email } = req.params;
        const query = { "seller.email": email };

        const result = await ordersCollection.find(query).toArray();
        res.status(200).json(result);
      } catch (error) {
        res.status(500).json({ message: "Server error", error });
      }
    });

    // Set or update user in database
    app.post("/user", async (req, res) => {
      const userData = req.body;

      userData.created_at = new Date().toISOString();
      userData.last_loggedIn = new Date().toISOString();
      userData.role = "customer";

      const query = { email: userData.email };
      const alreadyExist = await usersCollection.findOne(query);

      if (alreadyExist) {
        const result = await usersCollection.updateOne(query, {
          $set: { last_loggedIn: new Date().toISOString() },
        });
        return res.send(result);
      }

      const result = await usersCollection.insertOne(userData);
      res.send(result);
    });

    //get all users for manage users
    app.get("/users", verifyJWT, async (req, res) => {
      const adminEmail = req.tokenEmail
      const result = await usersCollection.find({email: {$ne: adminEmail}}).toArray()
      res.send(result)
    })

    //get a user role
    app.get("/user/role", verifyJWT, async (req, res) => {
      const result = await usersCollection.findOne({ email: req.tokenEmail });
      res.send({ role: result.role });
    });

    //save seller request
    app.post("/become-seller", verifyJWT, async (req, res) => {
      const email = req.tokenEmail;
      const alreadyExist = await becomeSellerCollection.findOne({ email });
      if (alreadyExist) {
        return res
          .status(409)
          .send({ message: "Already requested, please wait" });
      }
      const result = await becomeSellerCollection.insertOne({ email });
      res.send(result);
    });

    //get all Seller Requests from database
    app.get("/seller-requests", verifyJWT, async (req, res) => {
      const result = await becomeSellerCollection.find().toArray();
      res.send(result);
    });

    //update user role and delete from Seller Request collection if needed
    app.patch("/update-role", verifyJWT, async (req, res) => {
      const { email, role } = req.body;
      const result = await usersCollection.updateOne(
        { email },
        { $set: { role } }
      );
      await becomeSellerCollection.deleteOne({ email });
      res.send(result);
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello from Server..");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
