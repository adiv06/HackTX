import google.generativeai as genai

genai.configure(api_key="AIzaSyDq0vucSBAwNG4HeLCpztosoz4cS46f_sw")
for m in genai.list_models():
    print(m.name, m.supported_generation_methods)