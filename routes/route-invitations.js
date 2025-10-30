// routes/route-invitations.js
const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const nodemailer = require("nodemailer");
const { ensureAuthenticated } = require("../middleware/auth");

module.exports = (pool) => {
  const router = express.Router();

  // === Send Invitation ===
  router.post("/invite", ensureAuthenticated, async (req, res) => {
    try {
      const { email, role } = req.body;
      const inviter = req.user;

      // Validate input
      if (!email || !role) {
        return res.status(400).json({ error: "Email and role are required" });
      }

      if (!["manager", "bidder"].includes(role)) {
        return res.status(400).json({ error: "Invalid role" });
      }

      // Check if user already exists
      const existingUser = await pool.query(
        "SELECT id FROM users WHERE email = $1",
        [email]
      );

      if (existingUser.rows.length > 0) {
        return res.status(400).json({ error: "User already registered" });
      }

      // Check if there's an active invitation
      const existingInvite = await pool.query(
        "SELECT id, expires_at FROM invitations WHERE email = $1 AND accepted = false",
        [email]
      );

      if (existingInvite.rows.length > 0) {
        const expiresAt = new Date(existingInvite.rows[0].expires_at);
        if (expiresAt > new Date()) {
          return res.status(400).json({ 
            error: "An active invitation already exists for this email address" 
          });
        }
        // Delete expired or any existing invitation for this email
        await pool.query(
          "DELETE FROM invitations WHERE email = $1",
          [email]
        );
      }

      // Get inviter's organisation
      const inviterData = await pool.query(
        "SELECT organisation_id FROM users WHERE id = $1",
        [inviter.id]
      );

      const organisation_id = inviterData.rows[0]?.organisation_id || null;

      // Generate unique token
      const token = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

      // Store invitation (use ON CONFLICT to handle any edge cases)
      await pool.query(
        `INSERT INTO invitations (email, role, token, expires_at, organisation_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (email) DO UPDATE 
         SET role = $2, token = $3, expires_at = $4, organisation_id = $5, accepted = false`,
        [email, role, token, expiresAt, organisation_id]
      );

      // Send email
      // Dynamically determine the app URL based on environment
      // Priority: APP_URL (custom) > RENDER_EXTERNAL_URL (auto) > localhost (dev)
      console.log("🔍 Environment variables check:");
      console.log("  - APP_URL:", process.env.APP_URL);
      console.log("  - RENDER_EXTERNAL_URL:", process.env.RENDER_EXTERNAL_URL);
      console.log("  - All env keys containing 'URL':", Object.keys(process.env).filter(k => k.includes('URL')));
      
      const appUrl = process.env.APP_URL || 
                     (process.env.RENDER_EXTERNAL_URL || "http://localhost:4000");
      const inviteLink = `${appUrl}/invite/${token}`;
      
      console.log("📧 Sending invite with APP_URL:", process.env.APP_URL);
      console.log("📧 RENDER_EXTERNAL_URL:", process.env.RENDER_EXTERNAL_URL);
      console.log("📧 Using appUrl:", appUrl);
      console.log("📧 Final invite link:", inviteLink);
      
      try {
        const transporter = nodemailer.createTransport({
          service: "gmail",
          auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,
          },
        });

        await transporter.sendMail({
          from: process.env.EMAIL_USER,
          to: email,
          subject: "You're invited to join Tendersmith",
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #0078d4;">Welcome to Tendersmith</h2>
              <p>You've been invited to join Tendersmith as a <strong>${role}</strong>.</p>
              <p>Click the link below to create your account:</p>
              <p style="margin: 30px 0;">
                <a href="${inviteLink}" style="background: #0078d4; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block;">
                  Create Account
                </a>
              </p>
              <p style="color: #666; font-size: 14px;">
                This invitation will expire in 7 days.
              </p>
              <p style="color: #666; font-size: 14px;">
                If you didn't expect this invitation, you can safely ignore this email.
              </p>
            </div>
          `,
        });

        res.json({ 
          message: "Invitation sent successfully!",
          inviteLink: inviteLink // For testing purposes
        });
      } catch (emailErr) {
        console.error("Error sending email:", emailErr);
        // Still return success but note email failed
        res.json({ 
          message: "Invitation created but email failed to send. Invite link: " + inviteLink,
          inviteLink: inviteLink
        });
      }
    } catch (err) {
      console.error("Error sending invitation:", err);
      res.status(500).json({ error: "Failed to send invitation" });
    }
  });

  // === Accept Invitation ===
  router.post("/invite/accept", async (req, res) => {
    try {
      const { token, password, first_name, last_name } = req.body;

      if (!token || !password || !first_name || !last_name) {
        return res.status(400).json({ error: "All fields are required" });
      }

      // Find invitation
      const inviteResult = await pool.query(
        "SELECT * FROM invitations WHERE token = $1 AND accepted = false",
        [token]
      );

      if (inviteResult.rows.length === 0) {
        return res.status(404).json({ error: "Invalid or expired invitation" });
      }

      const invitation = inviteResult.rows[0];

      // Check expiration
      if (new Date(invitation.expires_at) < new Date()) {
        return res.status(400).json({ error: "This invitation has expired" });
      }

      // Hash password
      const password_hash = await bcrypt.hash(password, 10);

      // Create user
      const newUser = await pool.query(
        `INSERT INTO users (first_name, last_name, email, password_hash, role, organisation_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, first_name, last_name, email, role, organisation_id`,
        [first_name, last_name, invitation.email, password_hash, invitation.role, invitation.organisation_id]
      );

      // Mark invitation as accepted
      await pool.query(
        "UPDATE invitations SET accepted = true WHERE id = $1",
        [invitation.id]
      );

      res.json({
        message: "Account created successfully",
        user: newUser.rows[0],
      });
    } catch (err) {
      console.error("Error accepting invitation:", err);
      res.status(500).json({ error: "Failed to create account" });
    }
  });

  // === Request Access (sends email to admin) ===
  router.post("/request-access", async (req, res) => {
    try {
      const { fullName, company, email } = req.body;

      if (!fullName || !company || !email) {
        return res.status(400).json({ error: "All fields are required" });
      }

      // Send email notification to admin
      try {
        const transporter = nodemailer.createTransport({
          service: "gmail",
          auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,
          },
        });

        await transporter.sendMail({
          from: process.env.EMAIL_USER,
          to: "scotty@tendersmith.com",
          subject: "New Access Request - Tendersmith",
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #0078d4;">New Access Request</h2>
              <p>Someone has requested access to Tendersmith:</p>
              <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                <tr>
                  <td style="padding: 8px; border: 1px solid #ddd; background: #f8f9fa; font-weight: bold; width: 150px;">Name:</td>
                  <td style="padding: 8px; border: 1px solid #ddd;">${fullName}</td>
                </tr>
                <tr>
                  <td style="padding: 8px; border: 1px solid #ddd; background: #f8f9fa; font-weight: bold;">Company:</td>
                  <td style="padding: 8px; border: 1px solid #ddd;">${company}</td>
                </tr>
                <tr>
                  <td style="padding: 8px; border: 1px solid #ddd; background: #f8f9fa; font-weight: bold;">Email:</td>
                  <td style="padding: 8px; border: 1px solid #ddd;">${email}</td>
                </tr>
              </table>
              <p style="color: #666; font-size: 14px;">
                To grant access, send them an invitation from the Tendersmith account page.
              </p>
            </div>
          `,
        });

        res.json({ 
          message: "Access request submitted successfully"
        });
      } catch (emailErr) {
        console.error("Error sending access request email:", emailErr);
        res.status(500).json({ error: "Failed to send access request" });
      }
    } catch (err) {
      console.error("Error processing access request:", err);
      res.status(500).json({ error: "Failed to process request" });
    }
  });

  // === Forgot Password (sends reset link) ===
  router.post("/forgot-password", async (req, res) => {
    try {
      const { email } = req.body;

      if (!email) {
        return res.status(400).json({ error: "Email is required" });
      }

      // Check if user exists
      const userResult = await pool.query(
        "SELECT id, first_name FROM users WHERE email = $1",
        [email]
      );

      if (userResult.rows.length === 0) {
        // Don't reveal if email exists or not for security
        return res.json({ message: "If that email exists, a reset link has been sent." });
      }

      const user = userResult.rows[0];

      // Generate reset token
      const resetToken = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      // Store reset token in password_resets table
      await pool.query(
        `INSERT INTO password_resets (email, token, expires_at)
         VALUES ($1, $2, $3)`,
        [email, resetToken, expiresAt]
      );

      // Send reset email
      const appUrl = process.env.APP_URL || 
                     process.env.RENDER_EXTERNAL_URL || 
                     "http://localhost:4000";
      const resetLink = `${appUrl}/reset-password/${resetToken}`;

      try {
        const transporter = nodemailer.createTransport({
          service: "gmail",
          auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,
          },
        });

        await transporter.sendMail({
          from: process.env.EMAIL_USER,
          to: email,
          subject: "Reset Your Tendersmith Password",
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #0078d4;">Password Reset Request</h2>
              <p>Hi ${user.first_name || 'there'},</p>
              <p>We received a request to reset your password for your Tendersmith account.</p>
              <p style="margin: 30px 0;">
                <a href="${resetLink}" style="background: #0078d4; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block;">
                  Reset Password
                </a>
              </p>
              <p style="color: #666; font-size: 14px;">
                This link will expire in 1 hour.
              </p>
              <p style="color: #666; font-size: 14px;">
                If you didn't request this password reset, you can safely ignore this email.
              </p>
            </div>
          `,
        });

        res.json({ message: "If that email exists, a reset link has been sent." });
      } catch (emailErr) {
        console.error("Error sending reset email:", emailErr);
        res.status(500).json({ error: "Failed to send reset email" });
      }
    } catch (err) {
      console.error("Error processing password reset:", err);
      res.status(500).json({ error: "Failed to process request" });
    }
  });

  // === Reset Password ===
  router.post("/reset-password", async (req, res) => {
    try {
      const { token, password } = req.body;

      if (!token || !password) {
        return res.status(400).json({ error: "Token and password are required" });
      }

      if (password.length < 6) {
        return res.status(400).json({ error: "Password must be at least 6 characters" });
      }

      // Find reset token
      const resetResult = await pool.query(
        "SELECT * FROM password_resets WHERE token = $1 AND used = false",
        [token]
      );

      if (resetResult.rows.length === 0) {
        return res.status(404).json({ error: "Invalid or expired reset link" });
      }

      const resetRecord = resetResult.rows[0];

      // Check expiration
      if (new Date(resetRecord.expires_at) < new Date()) {
        return res.status(400).json({ error: "This reset link has expired" });
      }

      // Hash new password
      const password_hash = await bcrypt.hash(password, 10);

      // Update user password
      await pool.query(
        "UPDATE users SET password_hash = $1 WHERE email = $2",
        [password_hash, resetRecord.email]
      );

      // Mark reset token as used
      await pool.query(
        "UPDATE password_resets SET used = true WHERE id = $1",
        [resetRecord.id]
      );

      res.json({ message: "Password reset successfully" });
    } catch (err) {
      console.error("Error resetting password:", err);
      res.status(500).json({ error: "Failed to reset password" });
    }
  });

  // === Get Pending Invitations ===
  router.get("/invitations/pending", ensureAuthenticated, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT id, email, role, expires_at, created_at 
         FROM invitations 
         WHERE accepted = false 
         ORDER BY created_at DESC`
      );
      res.json(result.rows);
    } catch (err) {
      console.error("Error fetching invitations:", err);
      res.status(500).json({ error: "Failed to fetch invitations" });
    }
  });

  // === Delete Invitation ===
  router.delete("/invitations/:id", ensureAuthenticated, async (req, res) => {
    try {
      const { id } = req.params;
      
      await pool.query("DELETE FROM invitations WHERE id = $1", [id]);
      
      res.json({ message: "Invitation deleted successfully" });
    } catch (err) {
      console.error("Error deleting invitation:", err);
      res.status(500).json({ error: "Failed to delete invitation" });
    }
  });

  return router;
};
