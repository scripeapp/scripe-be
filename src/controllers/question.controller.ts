import { SupabaseRequest } from "../types/http";
import ApiResponse from "../utils/apiResponse";
import { Request, Response } from "express";

// EVENTS QUESTIONS MANAGEMENT.

/**
 * @desc Create a new question for an event
 * @access Private (Any authenticated user)
 * @endpoint POST /api/events/:eventId/questions
 */

export const createEventQuestion = async (req: SupabaseRequest, res: Response) => {
  try {
    const { eventId } = req.params;
    const { question } = req.body;
    const userId = req.user_id;

    if (!question || !question.trim()) {
      return ApiResponse.badRequest(res, "Question is required");
    }

    // Verify event exists
    const { data: event, error: eventError } = await req.supabase!
      .from("events")
      .select("id")
      .eq("id", eventId)
      .single();

    if (eventError) {
      return ApiResponse.notFound(res, "Event not found");
    }

    // Get user's name from profile
    let askedByName = "Anonymous User";

    if ((req as any).userProfile && (req as any).userProfile.name) {
      askedByName = (req as any).userProfile.name;
    } else {
      // Try to get from profiles table
      const { data: profile } = await req.supabase!
        .from("users")
        .select("name")
        .eq("id", userId)
        .single();

      if (profile && profile.name) {
        askedByName = profile.name;
      }
    }

    // Create question
    // Insert event question directly
    const { data: createdQuestion, error: createErr } = await req.supabase!
      .from("event_questions")
      .insert([
        {
          event_id: eventId,
          question,
          asked_by: userId,
          asked_by_name: askedByName,
          is_answered: false,
          is_hidden: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ])
      .select(
        `
        id,
        question,
        asked_by,
        asked_by_name,
        is_answered,
        answer,
        is_hidden,
        created_at,
        profiles:asked_by (
          id,
          name
        )
      `
      )
      .single();

    if (createErr) throw createErr;

    return ApiResponse.created(
      res,
      "Question created successfully",
      createdQuestion
    );
  } catch (error: any) {
    console.error("Error creating question:", error);
    return ApiResponse.serverError(res, error.message);
  }
};
/**
 * @desc Get all questions for an event
 * @access Public (non-hidden questions) / Private (all questions for manager)
 * @endpoint GET /api/events/:eventId/questions
 */

export const getEventQuestions = async (req: SupabaseRequest, res: Response) => {
  try {
    const { eventId } = req.params;
    const userId = req.user_id;

    // Verify event exists
    const { data: event, error: eventError } = await req.supabase!
      .from("events")
      .select("id, user_id, business_id")
      .eq("id", eventId)
      .single();

    if (eventError) {
      return ApiResponse.notFound(res, "Event not found");
    }

    // Check if user is the manager (owner or business member)
    const isManager = userId === event.user_id || !!(req.businessId && req.businessId === event.business_id);

    // Get questions
    // Build query for event questions
    let query = req.supabase!
      .from("event_questions")
      .select(
        `
        id,
        question,
        asked_by,
        asked_by_name,
        is_answered,
        answer,
        is_hidden,
        created_at,
        answered_by,
        profiles:asked_by (
          id,
          name
        ),
        answered_profiles:answered_by (
          id,
          name
        )
      `
      )
      .eq("event_id", eventId);

    if (!isManager) {
      query = query.eq("is_hidden", false);
    }

    const { data: questions, error: qErr } = await query.order("created_at", { ascending: false });
    if (qErr) throw qErr;

    return ApiResponse.success(
      res,
      "Questions retrieved successfully",
      questions
    );
  } catch (error: any) {
    console.error("Error getting questions:", error);
    return ApiResponse.serverError(res, error.message);
  }
};

/**
 * @desc Answer a question
 * @access Private (Only event manager)
 * @endpoint POST /api/events/:eventId/questions/:questionId/answer
 */

export const answerEventQuestion = async (req: SupabaseRequest, res: Response) => {
  try {
    const { questionId } = req.params;
    const { answer } = req.body;
    const userId = req.user_id;

    if (!answer || !answer.trim()) {
      return ApiResponse.badRequest(res, "Answer is required");
    }

    // Verify question exists
    const { data: question, error: questionError } = await req.supabase!
      .from("event_questions")
      .select("id")
      .eq("id", questionId)
      .single();

    if (questionError) {
      return ApiResponse.notFound(res, "Question not found");
    }

    // Answer question
    const { data: updatedQuestion, error: updErr } = await req.supabase!
      .from("event_questions")
      .update({
        answer,
  answered_by: userId!,
        is_answered: true,
        updated_at: new Date().toISOString(),
      })
      .eq("id", questionId)
      .select(
        `
        id,
        question,
        asked_by,
        asked_by_name,
        is_answered,
        answer,
        is_hidden,
        created_at,
        updated_at,
        answered_by,
        profiles:asked_by (
          id,
          name
        ),
        answered_profiles:answered_by (
          id,
          name
        )
      `
      )
      .single();
    if (updErr) throw updErr;

    return ApiResponse.success(
      res,
      "Question answered successfully",
      updatedQuestion
    );
  } catch (error: any) {
    console.error("Error answering question:", error);
    return ApiResponse.serverError(res, error.message);
  }
};

/**
 * @desc Toggle question visibility
 * @access Private (Only event manager)
 * @endpoint PATCH /api/events/:eventId/questions/:questionId/visibility
 */

export const toggleEventQuestionVisibility = async (req: SupabaseRequest, res: Response) => {
  try {
    const { questionId } = req.params;

    // Verify question exists
    const { data: question, error: questionError } = await req.supabase!
      .from("event_questions")
      .select("id")
      .eq("id", questionId)
      .single();

    if (questionError) {
      return ApiResponse.notFound(res, "Question not found");
    }

    // Toggle visibility
    // fetch current state
    const { data: current, error: currentErr } = await req.supabase!
      .from("event_questions")
      .select("is_hidden")
      .eq("id", questionId)
      .single();
    if (currentErr) throw currentErr;

    const { data: updatedQuestion, error: tErr } = await req.supabase!
      .from("event_questions")
      .update({ is_hidden: !current.is_hidden, updated_at: new Date().toISOString() })
      .eq("id", questionId)
      .select(
        `
        id,
        question,
        asked_by,
        asked_by_name,
        is_answered,
        answer,
        is_hidden,
        created_at,
        updated_at
      `
      )
      .single();
    if (tErr) throw tErr;

    return ApiResponse.success(
      res,
      `Question ${
        updatedQuestion.is_hidden ? "hidden" : "unhidden"
      } successfully`,
      updatedQuestion
    );
  } catch (error: any) {
    console.error("Error toggling question visibility:", error);
    return ApiResponse.serverError(res, error.message);
  }
};

/**
 * @desc Delete a question
 * @access Private (Only event manager)
 * @endpoint DELETE /api/events/:eventId/questions/:questionId
 */

export const deleteEventQuestion = async (req: SupabaseRequest, res: Response) => {
  try {
    const { questionId } = req.params;

    // Verify question exists
    const { data: question, error: questionError } = await req.supabase!
      .from("event_questions")
      .select("id")
      .eq("id", questionId)
      .single();

    if (questionError) {
      return ApiResponse.notFound(res, "Question not found");
    }

    // Delete question
    const { error: delErr } = await req.supabase!
      .from("event_questions")
      .delete()
      .eq("id", questionId);
    if (delErr) throw delErr;

    return ApiResponse.success(res, "Question deleted successfully");
  } catch (error: any) {
    console.error("Error deleting question:", error);
    return ApiResponse.serverError(res, error.message);
  }
};